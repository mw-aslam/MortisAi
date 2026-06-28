const Groq = require('groq-sdk');
require('dotenv').config();
const key = process.env.GROQ_API_KEY_FREE.split(',')[0];
const groq = new Groq({apiKey: key});
groq.models.list().then(res => console.log(res.data.map(m => m.id).join(', '))).catch(console.error);
