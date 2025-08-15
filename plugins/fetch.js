import fetch from 'node-fetch'
import path from 'path'
import fs from 'fs'
import mime from 'mime-types'

export default [
  {
    name: 'fetch',
    category: 'tools',
    description: 'Fetch one or more URLs and send content based on type',
    handler: async ({ msg, Dave }) => {
      // Collect all possible text sources
      const sources = [
        msg.body,
        msg.quoted?.text || '',
      ].join(' ')

      // Extract all unique URLs
      const urls = [...new Set(sources.match(/https?:\/\/[^\s]+/gi) || [])]

      if (!urls.length) {
        return Dave.sendMessage(
          msg.key.remoteJid,
          { text: '❌ Please provide or quote at least one valid URL.' },
          { quoted: msg }
        )
      }

      for (const url of urls) {
        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`HTTP ${res.status} - ${res.statusText}`)

          const contentType = res.headers.get('content-type') || ''
          const buffer = await res.arrayBuffer()
          const data = Buffer.from(buffer)

          if (contentType.startsWith('image/')) {
            await Dave.sendMessage(msg.key.remoteJid, { image: data, caption: `📷 From ${url}` }, { quoted: msg })
          } 
          else if (contentType.startsWith('video/')) {
            await Dave.sendMessage(msg.key.remoteJid, { video: data, caption: `🎥 From ${url}` }, { quoted: msg })
          } 
          else if (contentType.startsWith('audio/')) {
            await Dave.sendMessage(msg.key.remoteJid, { audio: data, mimetype: contentType }, { quoted: msg })
          } 
          else if (contentType.includes('text') || contentType.includes('json')) {
            const text = data.toString('utf8')
            if (text.length < 1500) {
              await Dave.sendMessage(msg.key.remoteJid, { text: `📝 From ${url}\n\n${text}` }, { quoted: msg })
            } else {
              const filePath = path.join('./temp', `fetched_${Date.now()}.txt`)
              fs.writeFileSync(filePath, text)
              await Dave.sendMessage(
                msg.key.remoteJid,
                { document: fs.readFileSync(filePath), mimetype: 'text/plain', fileName: 'fetched.txt' },
                { quoted: msg }
              )
              fs.unlinkSync(filePath)
            }
          } 
          else {
            const ext = mime.extension(contentType) || 'bin'
            const filePath = path.join('./temp', `fetched_${Date.now()}.${ext}`)
            fs.writeFileSync(filePath, data)
            await Dave.sendMessage(
              msg.key.remoteJid,
              { document: fs.readFileSync(filePath), mimetype: contentType, fileName: `fetched.${ext}` },
              { quoted: msg }
            )
            fs.unlinkSync(filePath)
          }

        } catch (err) {
          console.error(err)
          await Dave.sendMessage(msg.key.remoteJid, { text: `❌ Failed to fetch: ${url}\n${err.message}` }, { quoted: msg })
        }
      }
    }
  }
]
