// server.js
import express from 'express'
const app = express()

app.get('/', (_, res) => {
  res.send('🟢 XYLO-MD is alive')
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
})
