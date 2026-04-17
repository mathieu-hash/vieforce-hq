require('dotenv').config({ path: '.env.local' })
const express = require('express')
const cors = require('cors')
const app = express()
const PORT = process.env.PORT || 8080

// CORS — allow Vercel frontend (all preview/branch URLs) + localhost
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (curl, server-to-server)
    if (!origin) return callback(null, true);
    // Allow any *.vercel.app domain (production + all preview deploys)
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    // Allow Cloud Run domains
    if (origin.endsWith('.run.app')) return callback(null, true);
    // Allow localhost for dev
    if (origin.startsWith('http://localhost:')) return callback(null, true);
    // Block everything else
    callback(new Error('CORS not allowed from ' + origin));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['x-session-id', 'content-type']
}))

app.use(express.json())

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'vieforce-hq-api', version: '1.0.0' })
})

// Import all API handlers
// Vercel handlers export async (req, res) => {} which is Express-compatible
const dashboardHandler = require('./api/dashboard')
const salesHandler = require('./api/sales')
const arHandler = require('./api/ar')
const inventoryHandler = require('./api/inventory')
const speedHandler = require('./api/speed')
const customersHandler = require('./api/customers')
const customerHandler = require('./api/customer')
const diagHandler = require('./api/diag')
const marginHandler = require('./api/margin')
const intelligenceHandler = require('./api/intelligence')
const teamHandler = require('./api/team')
const budgetHandler = require('./api/budget')
const itemizedHandler = require('./api/itemized')
const itemizedMetaHandler = require('./api/itemized-meta')

// Mount routes
app.get('/api/dashboard', dashboardHandler)
app.get('/api/sales', salesHandler)
app.get('/api/ar', arHandler)
app.get('/api/inventory', inventoryHandler)
app.get('/api/speed', speedHandler)
app.get('/api/customers', customersHandler)
app.get('/api/customer', customerHandler)
app.get('/api/diag', diagHandler)
app.get('/api/margin', marginHandler)
app.get('/api/intelligence', intelligenceHandler)
app.get('/api/team', teamHandler)
app.get('/api/budget', budgetHandler)
app.get('/api/itemized', itemizedHandler)
app.get('/api/itemized/meta', itemizedMetaHandler)

// CORS preflight handled by cors() middleware above — no manual handler needed

app.listen(PORT, () => {
  console.log(`VieForce HQ API running on port ${PORT}`)
})
