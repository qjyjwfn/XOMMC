addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  if (request.method === 'POST') {
    const update = await request.json()
    const msg = update.message
    
    if (msg && (msg.video || msg.video_note || msg.animation)) {
      const newCaption = (msg.reply_to_message && msg.reply_to_message.text) 
        ? msg.reply_to_message.text 
        : (msg.caption || "✅ 已去除转发来源")
      
      await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          chat_id: msg.chat.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
          caption: newCaption
        })
      })
    }
  }
  return new Response('OK')
}

// ================= 配置 =================
const TOKEN = 'YOUR_BOT_TOKEN_HERE'  // ←←← 改成你的 Token
