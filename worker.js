addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (typeof TOKEN === 'undefined' || !TOKEN) {
    console.error('❌ 未读取到 TOKEN，请检查 CF 后台环境变量设置')
    return new Response('TOKEN is missing', { status: 500 })
  }

  try {
    const update = await request.json()
    const msg = update.message || update.channel_post

    if (msg) {
      // 场景 1：如果回复了机器人发出的消息，并且输入了纯文本 -> 修改机器人原消息的文案
      if (msg.reply_to_message && msg.text && !msg.video && !msg.photo) {
        const targetMessageId = msg.reply_to_message.message_id
        
        await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageCaption`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            message_id: targetMessageId,
            caption: msg.text
          })
        })
        return new Response('OK')
      }

      // 场景 2：发送或转发媒体（视频、图片、文件等） -> 无痕转发
      const isVideoNote = !!msg.video_note
      const hasMedia = msg.video || msg.animation || isVideoNote || msg.photo || msg.document

      if (hasMedia) {
        const payload = {
          chat_id: msg.chat.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id
        }

        // 非圆视频保留原文案，无文案则不传
        if (!isVideoNote && msg.caption) {
          payload.caption = msg.caption
        }

        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })

        const resData = await res.json()
        if (!resData.ok) {
          console.error('Telegram API 返回错误:', JSON.stringify(resData))
        }
      }
    }
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
