export default [
  {
    name: 'test',
    description: 'Debug full message object',
    category: 'debug',
    handler: async ({ msg, Dave, from, reply }) => {
      try {
        // Convert full message object to JSON
        let raw = JSON.stringify(msg, null, 2);

        // Split into safe chunks (WhatsApp text limit ~4096, using 3000 for safety)
        const chunks = raw.match(/[\s\S]{1,3000}/g) || [];

        if (chunks.length === 0) {
          return reply("⚠️ Could not stringify message object.");
        }

        // Send chunks one by one
        for (let i = 0; i < chunks.length; i++) {
          await Dave.sendMessage(from, { 
            text: "```" + chunks[i] + "```" 
          }, { quoted: msg });
        }

      } catch (err) {
        console.error("Test command error:", err);
        reply("❌ An error occurred while debugging.");
      }
    }
  }
]
