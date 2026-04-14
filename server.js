const express = require('express')
const cors = require('cors')
const app = express()
const PORT = process.env.PORT || 8080

// CORS — allow Vercel frontend + localhost
app.use(cors({
  origin: [
    'https://vieforce-hq.vercel.app',
    'http://localhost:3000',
    'http://localhost:5500'
  ],
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

// Mount routes
app.get('/api/dashboard', dashboardHandler)
app.get('/api/sales', salesHandler)
app.get('/api/ar', arHandler)
app.get('/api/inventory', inventoryHandler)
app.get('/api/speed', speedHandler)
app.get('/api/customers', customersHandler)
app.get('/api/customer', customerHandler)

// CORS preflight for all API routes
app.options('/api/*', (req, res) => res.status(200).end())

app.listen(PORT, () => {
  console.log(`VieForce HQ API running on port ${PORT}`)
})
