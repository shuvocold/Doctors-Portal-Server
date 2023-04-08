const express = require('express');
const cors = require('cors');



const jwt = require('jsonwebtoken');

// dotenv 
require('dotenv').config();

// This is your test secret API key.
const stripe = require("stripe")(process.env.STRIPE_KEY);

const port = process.env.PORT || 5000;

const app = express();

// middleware 

app.use(cors());
app.use(express.json());



// importing nodemailer
const nodemailer = require('nodemailer');

// mailgun 
const mg = require('nodemailer-mailgun-transport');


// nodemailer code part 

function sendBookingEmail(bookings) {

    const { email, treatment, appointmentDate, slot } = bookings;


    // ----------------sendgrid part -----------------

    /*      let transporter = nodemailer.createTransport({
            host: 'smtp.sendgrid.net',
            port: 587,
            auth: {
                user: "apikey",
                pass: process.env.SENDGRID_API_KEY
            }
        })
     */

    //  mailgun part start 
    // transporter 

    const auth = {
        auth: {
            api_key: process.env.MAILGUN_API_KEY,
            domain: process.env.EMAIL_SEND_DOMAIN
        }
    }

    const transporter = nodemailer.createTransport(mg(auth));

    transporter.sendMail({
        from: "rudrosingh82@gmail.com", // verified sender email
        to: email, // recipient email
        subject: `Your treatment for ${treatment} is confirmed`, // Subject line
        text: "Hello world!", // plain text body
        html: `
         <h3>Your appointment is confirmed</h3>
         <div>
         <p>Your appointment for treatment ${treatment}</p>
         <p>Please visit us on ${appointmentDate} at ${slot}</p>
         <p>Thanks from doctors portal</p>
         </div>
         `, // html body
    }, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });




}




// connecting 

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.akihfew.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


// verifying jwt --middleware(creating custom middleware)
function verifyJWT(req, res, next) {
    // console.log('bookings', req.headers.authorization);
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized access')
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'forbidden access' });
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try {
        const appointmentOptionsCollection = client.db('doctorsPortal').collection('appointmentOption');
        // this collection is for booking 
        const bookingCollection = client.db('doctorsPortal').collection('bookings');
        // This collection is for users 
        const usersCollection = client.db('doctorsPortal').collection('users');
        // this one is for doctors collection 
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');

        // payment related collection 
        const paymentsCollection = client.db('doctorsPortal').collection('payments');



        // ----middleware for checking admin and giving role - make sure you use verifyAdmin after verifyJwt
        const verifyAdmin = async (req, res, next) => {
            // console.log('inside verify', req.decoded.email);
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'unauthorized user' })
            }

            next();
        }


        // this is not the best practice.. use aggregate to query multiple collection and then merge data 
        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            // console.log(date);
            const query = {};

            // get the bookings of the provided date 

            const bookingQuery = { appointmentDate: date }
            const options = await appointmentOptionsCollection.find(query).toArray();

            // checking booked data 
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();


            // code carefully 
            options.forEach(option => {
                // console.log(option);
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name)
                // console.log(optionBooked);
                const bookedSlot = optionBooked.map(book => book.slot);
                const remainingSlot = option.slots.filter(slot => !bookedSlot.includes(slot));
                option.slots = remainingSlot;
                // console.log(date, option.name, bookedSlot, remainingSlot.length);
            })

            res.send(options)
        })


        // speciality section 

        app.get('/appointmentSpeciality', async (req, res) => {
            const query = {};
            const result = await appointmentOptionsCollection.find(query).project({ name: 1 }).toArray();
            res.send(result);
        })


        // posting data to backend 

        // getting booking datas 
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            // console.log(email);
            // console.log('bookings', req.headers.authorization);
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'forbidden access' })
            }
            const query = { email: email };
            const bookings = await bookingCollection.find(query).toArray();
            res.send(bookings);
        })


        // getting specific bookings 

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingCollection.findOne(query);
            res.send(booking);
        })

        app.post('/bookings', async (req, res) => {
            const bookings = req.body;
            // console.log(bookings);
            const query = {
                appointmentDate: bookings.appointmentDate,
                treatment: bookings.treatment,
                email: bookings.email
            }

            const alreadyBooked = await bookingCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `you already have a booking on ${bookings.appointmentDate}`;
                return res.send({ acknowleged: false, message });
            }

            const results = await bookingCollection.insertOne(bookings);

            // send email about appointment confirmation 
            sendBookingEmail(bookings);

            res.send(results);
        });


        // ------------stripe payment option ------------------

        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                currency: "usd",
                amount: amount,
                "payment_method_types": [
                    "card"
                ]
            })

            res.send({
                clientSecret: paymentIntent.client_secret,
            });


        })


        // ---------saving payment info to db ------------

        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const results = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }
            const updatedResult = await bookingCollection.updateOne(filter, updatedDoc)
            res.send(results);
        })


        // jwt part 
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '5h' });
                return res.send({ accessToken: token })
            }


            // console.log(user);
            res.status(403).send({ accessToken: '' })
        })


        // getting all users 
        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        })

        // checking admin user 
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' })
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })

        // making an user admin 

        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {

            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true }
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });


        // temporary to update price price field on appointment option -- put na lekhe eikhane get o kora jai but kora uchit na 

        /*         app.get('/addprice', async (req, res) => {
                    const filter = {};
                    const options = { upsert: true };
                    const updatedDoc = {
                        $set: {
                            price: 50
                        }
                    }
                    const result = await appointmentOptionsCollection.updateMany(filter, updatedDoc, options);
                    res.send(result);
        
                }) */

        // this one is for doctors part  
        // adding doctor 

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })

        // getting doctors data 
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        })

        // deleting doctor api 
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })

    }
    finally {

    }
}
run().catch(error => console.error(error))




app.get('/', (req, res) => {
    res.send('Doctors portal running');
})

app.listen(port, () => {
    console.log('running on port - ', port);
})