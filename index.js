const express = require('express');
const cors = require('cors');
const dns = require('dns');
require('dotenv').config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// DNS Fix
dns.setServers(['8.8.8.8', '8.8.4.4']);

// MongoDB URI
const uri = process.env.DBURL;

if (!uri) {
  console.error('DBURL not found in .env file');
  process.exit(1);
}

// MongoDB Client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// let dbConnection = null;
// async function getCollection() {
//   if (!dbConnection) {
//     await client.connect();
//     dbConnection = client.db('icc_clients');
//     console.log('MongoDB Connected Successfully ✔️');
//   }
//   return dbConnection.collection('users');
// }

let dbConnection = null;
async function getCollection() {
  if (!dbConnection) {
    await client.connect();
    dbConnection = client.db('icc_clients');
    console.log('MongoDB Connected Successfully ✔️');

    // 👇 [এখানে মাইগ্রেশন কোডটি বসিয়ে দিন]
    try {
      const promiseCollection = dbConnection.collection('promises');
      
      // যেসব ডাটায় promise_day ফিল্ডটি নেই সেগুলো খুঁজে বের করবে
      const oldDocs = await promiseCollection.find({ promise_day: { $exists: false } }).toArray();
      
      if (oldDocs.length > 0) {
        console.log(`Fixing ${oldDocs.length} old promise logs for day-based filtering... ⏳`);
        
        for (const doc of oldDocs) {
          if (doc.promise_date && typeof doc.promise_date === 'string') {
            // ফিক্সড লজিক: "2026-06-12" থেকে [2] নম্বর ইনডেক্স অর্থাৎ '12' কে আলাদা করা হচ্ছে 🎯
            const dayParts = doc.promise_date.split('-');
            if (dayParts.length === 3) {
              const day = parseInt(dayParts[2], 10);
              
              if (!isNaN(day)) {
                await promiseCollection.updateOne(
                  { _id: doc._id }, 
                  { $set: { promise_day: day } }
                );
              }
            }
          }
        }
        console.log('Old promises updated perfectly with day stamp! 🎉');
      }
    } catch (migrateError) {
      console.error("Migration Error:", migrateError);
    }
    // ☝️ [মাইগ্রেশন ব্লকের শেষ]

  }
  return dbConnection.collection('users');
}

// Insert Client
app.post('/insert-client', async (req, res) => {
  try {
    const myColl = await getCollection();
    const body = req.body;

    if (body.sl) body.sl = parseInt(body.sl, 10);
    if (body.amount) body.amount = parseFloat(body.amount) || 0;

    const existingClient = await myColl.findOne({
      $or: [{ mobile: body.mobile }, { ip: body.ip }]
    });

    if (existingClient) {
      return res.status(400).json({
        success: false,
        message: 'Client with this IP or Mobile already exists!'
      });
    }

    body.createdAt = new Date();
    body.status = 'Active';

    const result = await myColl.insertOne(body);
    return res.status(201).json({ success: true, result });

  } catch (error) {
    console.error("Backend Error:", error);
    return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
});

// 🔄 Get All Clients with Dynamic Promise Data (تاریخ ভিত্তিক ফিক্সড 🎯)
app.get('/get-client-data', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const myColl = db.collection('users');
    const { search, date } = req.query; // ফ্রন্টএন্ড থেকে date প্যারামিটার রিসিভ করা হচ্ছে

    let matchQuery = {};

    if (search) {
      const searchNumber = parseInt(search, 10);
      if (!isNaN(searchNumber)) {
        matchQuery.$or = [
          { sl: searchNumber },
          { client_name: { $regex: search, $options: 'i' } },
          { mobile: { $regex: search, $options: 'i' } }
        ];
      } else {
        matchQuery.$or = [
          { client_name: { $regex: search, $options: 'i' } },
          { mobile: { $regex: search, $options: 'i' } },
          { ip: { $regex: search, $options: 'i' } },
        ];
      }
    }

    // 📅 ফ্রন্টএন্ড থেকে পাঠানো তারিখ অথবা ডিফল্ট আজকের তারিখ (Format: YYYY-MM-DD)
    let targetDate = date;
    if (!targetDate) {
      const now = new Date();
      const offset = now.getTimezoneOffset();
      const localDate = new Date(now.getTime() - (offset * 60 * 1000));
      targetDate = localDate.toISOString().split('T'); 
    }

    // Aggregation Pipeline: মাস/বছরের কোনো কন্ডিশন নেই, সরাসরি promise_date চেক হবে
    const result = await myColl.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: 'promises', 
          let: { clientIdStr: { $toString: "$_id" } }, 
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$clientId", "$$clientIdStr"] },
                    { $eq: ["$promise_date", targetDate] } // শুধুমাত্র তারিখ মিললেই জয়েন হবে 🎯
                  ]
                }
              }
            }
          ],
          as: 'current_promise'
        }
      },
      {
        $addFields: {
          promiseInfo: { $ifNull: [{ $arrayElemAt: ["$current_promise", 0] }, null] }
        }
      },
      { $project: { current_promise: 0 } }, 
      { $sort: { sl: 1 } }
    ]).toArray();

    res.status(200).send(result);

  } catch (error) {
    console.error("Fetch Clients Error:", error);
    res.status(500).send({ success: false, message: error.message });
  }
});

// Update Status
app.patch('/update-status', async (req, res) => {
  try {
    const myColl = await getCollection();
    const { id, status } = req.body;
    const result = await myColl.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    res.status(200).send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// Delete Client
app.delete('/delete-client/:id', async (req, res) => {
  try {
    const myColl = await getCollection();
    const result = await myColl.deleteOne({ _id: new ObjectId(req.params.id) });
    res.status(200).send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// পেমেন্ট চেক করার API
app.get('/check-payment/:id', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const paymentsColl = db.collection('payments');
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const paid = await paymentsColl.findOne({
      clientId: new ObjectId(req.params.id),
      paidDate: { $gte: startOfMonth, $lte: endOfMonth }
    });
    res.send({ isPaid: !!paid });
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// 📑 প্রমিজ পেজে শুধুমাত্র "দিন" দিয়ে ফিল্টার করার GET রাউট
app.get('/get-promises-data', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const promiseCollection = db.collection('promises'); 

    const { day, address, page = 1 } = req.query; // ফ্রন্টএন্ড থেকে পাঠানো 'day' রিসিভ হলো
    const limit = 30; 
    const skip = (parseInt(page) - 1) * limit;

    let query = {};

    // ১. যদি ফ্রন্টএন্ড থেকে দিন পাঠানো হয়
    if (day) {
      const targetDay = parseInt(day, 10);
      
      if (!isNaN(targetDay)) {
        // মঙ্গোডিবি কুয়েরির ভেতরেই promise_date-কে স্প্লিট করে দিন বের করার লজিক 🎯
        query.$expr = {
          $eq: [
            {
              $toInt: {
                $arrayElemAt: [
                  { $split: ["$promise_date", "-"] }, // "2026-06-23" কে ['2026', '06', '23'] করবে
                  2 // ২ নম্বর ইনডেক্স অর্থাৎ '23' কে টার্গেট করবে
                ]
              }
            },
            targetDay // ফ্রন্টএন্ড থেকে পাঠানো দিনের সাথে মেলাবে (যেমন: 23)
          ]
        };
      }
    }

    // ২. যদি অ্যাড্রেস দিয়ে সার্চ করা হয়
    if (address) { 
      query.address = { $regex: address, $options: 'i' }; 
    }

    const totalPromises = await promiseCollection.countDocuments(query);
    const promisesData = await promiseCollection
      .find(query)
      .sort({ promise_date: -1 }) // লেটেস্ট প্রমিজ আগে দেখাবে
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      totalPromises,
      totalPages: Math.ceil(totalPromises / limit) || 1,
      currentPage: parseInt(page),
      data: promisesData
    });
  } catch (error) {
    console.error("Fetch Promises Error:", error);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

// =========================================================================
// 🎯 নতুন প্রমিজ ডেটা এবং দিন (Day) আপডেট বা ইনসার্ট করার রাউট (FIXED 404)
// =========================================================================
app.patch('/update-promise-date', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const promiseCollection = db.collection('promises');
    
    const { id, client_name, ip, address, promise_date, promise_day, promise_note } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Client ID is required' });
    }

    // ১. প্রমিজ কালেকশনে এই ইউজারের ডাটা অলরেডি আছে কিনা চেক করা (clientId দিয়ে)
    const existingPromise = await promiseCollection.findOne({ clientId: id });

    const promiseData = {
      clientId: id,
      client_name: client_name || 'N/A',
      ip: ip || 'N/A',
      address: address || 'N/A',
      promise_date: promise_date, // ফুল ডেট (Format: YYYY-MM-DD)
      promise_day: parseInt(promise_day, 10) || null, // ⚡ আপনার রিকোয়েস্ট অনুযায়ী শুধু দিন (Day) সংখ্যায় সেভ হচ্ছে
      promise_note: promise_note || '',
      updatedAt: new Date()
    };

    let result;
    if (existingPromise) {
      // ২. যদি আগের প্রমিজ থাকে তবে সেটাকে আপডেট (Update) করবে
      result = await promiseCollection.updateOne(
        { clientId: id },
        { $set: promiseData }
      );
    } else {
      // ৩. যদি একদম নতুন প্রমিজ হয় তবে সেটা ইনসার্ট (Insert) করবে
      promiseData.createdAt = new Date();
      result = await promiseCollection.insertOne(promiseData);
    }

    // ⚡ একই সাথে মূল 'users' কালেকশনেও ডেটা সিঙ্ক করে দেওয়া হচ্ছে যাতে ইনস্ট্যান্ট ফ্রন্টএন্ডে রিফ্লেক্ট করে
    const usersColl = db.collection('users');
    await usersColl.updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: { 
          promise_date: promise_date,
          promise_note: promise_note || ''
        } 
      }
    );

    return res.status(200).json({ 
      success: true, 
      message: existingPromise ? 'Promise updated successfully ✔️' : 'Promise recorded successfully 🎉', 
      result 
    });

  } catch (error) {
    console.error("Update Promise Route Error:", error);
    return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
  }
});

// 🔴 চলতি মাসের আনপেইড (বকেয়া) ইউজারদের ডাটা ফেচ করার রাউট
app.get('/get-unpaid-users', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const usersColl = db.collection('users');
    const paymentsColl = db.collection('payments');
    const { zone } = req.query;

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); 
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); 

    const paidClientsThisMonth = await paymentsColl.find({
      paidDate: { $gte: startOfMonth, $lte: endOfMonth }
    }).project({ clientId: 1, _id: 0 }).toArray();

    const paidClientIds = paidClientsThisMonth.map(p => new ObjectId(p.clientId));

    let query = { _id: { $nin: paidClientIds }, status: 'Active' };

    if (zone && zone !== 'all') {
      query.zone = { $regex: zone, $options: 'i' };
    }

    const result = await usersColl.find(query).sort({ sl: 1 }).toArray();
    res.status(200).send({ success: true, totalUnpaid: result.length, data: result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// 📑 Get Payments History
app.get('/get-payments-data', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const paymentsColl = db.collection('payments');
    const { startDate, endDate, search } = req.query;
    let query = {};

    if (startDate && endDate) {
      query.paidDate = {
        $gte: new Date(`${startDate}T00:00:00.000+06:00`),
        $lte: new Date(`${endDate}T23:59:59.999+06:00`)
      };
    }

    if (search) {
      query.$or = [
        { client_name: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } },
        { ip: { $regex: search, $options: 'i' } }
      ];
    }

    const result = await paymentsColl.find(query).sort({ paidDate: -1 }).toArray();
    res.status(200).send({ success: true, totalPayments: result.length, data: result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// 💳 Payments Collection API
app.post('/payments', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const paymentsColl = db.collection('payments'); 
    const { paidId } = req.query; 
    const { amount } = req.body; 

    if (!paidId) return res.status(400).send({ success: false, message: 'Client ID is required' });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1); 
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59); 

    const alreadyPaidThisMonth = await paymentsColl.findOne({
      clientId: new ObjectId(paidId),
      paidDate: { $gte: startOfMonth, $lte: endOfMonth }
    });

    if (alreadyPaidThisMonth) {
      return res.status(400).send({ success: false, message: 'Already paid for the current month!' });
    }

    const usersColl = db.collection('users');
    const clientData = await usersColl.findOne({ _id: new ObjectId(paidId) });

    if (!clientData) return res.status(404).send({ success: false, message: 'Client not found' });

    const paymentInfo = {
      clientId: clientData._id,
      client_name: clientData.client_name,
      mobile: clientData.mobile || 'N/A',
      sl: clientData.sl || 'N/A',
      ip: clientData.ip || 'N/A',
      amount: parseInt(amount, 10) || clientData.amount || 0,
      receiptNo: req.body.receiptNo, 
      paidDate: new Date(),
      status: 'Paid'
    };

    const result = await paymentsColl.insertOne(paymentInfo);
    res.status(201).send({ success: true, message: 'Payment completed ✔️', result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// 📝 Update Client
app.patch('/update-client', async (req, res) => {
  try {
    const myColl = await getCollection();
    const { id, sl, client_name, mobile, ip, zone, speed, amount, address, status } = req.body;

    if (!id) return res.status(400).send({ success: false, message: 'Client ID is required' });

    const updateData = {
      sl: parseInt(sl, 10) || 0, 
      client_name, mobile, ip,
      zone: zone || '', speed: speed || '',
      amount: parseInt(amount, 10) || 0, 
      address: address || '',
      status: status || 'Active', 
      updatedAt: new Date()
    };

    const result = await myColl.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    res.status(200).send({ success: true, message: 'Client updated ✔️', result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// 🛠️ Expenses
app.post('/expenses', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const { title, amount, category, note } = req.body;
    if (!title || !amount) return res.status(400).send({ success: false, message: 'Required fields missing' });

    const result = await db.collection('expenses').insertOne({
      title, amount: parseFloat(amount) || 0, category: category || 'General', note: note || '', expenseDate: new Date(), createdAt: new Date()
    });
    res.status(201).send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

app.get('/expenses', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const { startDate, endDate } = req.query;
    let query = {};
    if (startDate && endDate) {
      query.expenseDate = {
        $gte: new Date(`${startDate}T00:00:00.000+06:00`), $lte: new Date(`${endDate}T23:59:59.999+06:00`)
      };
    }
    const result = await db.collection('expenses').find(query).sort({ expenseDate: -1 }).toArray();
    res.send({ success: true, totalExpenses: result.length, data: result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

app.delete('/expenses/:id', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const result = await db.collection('expenses').deleteOne({ _id: new ObjectId(req.params.id) });
    res.send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

app.get('/expenses-total', async (req, res) => {
  try {
    const db = dbConnection || (await client.connect(), client.db('icc_clients'));
    const result = await db.collection('expenses').aggregate([{ $group: { _id: null, totalExpense: { $sum: "$amount" } } }]).toArray();
    res.send({ success: true, totalExpense: result?.totalExpense || 0 });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

app.get('/', (req, res) => { res.send('ICC Client Server Running'); });
app.listen(port, () => { console.log(`Server running on port ${port}`); });

module.exports = app;