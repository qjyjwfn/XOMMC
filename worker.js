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
      // 场景 1：回复机器人发出的视频/图片 -> 修改其文案
      if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
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

      // 场景 2：转发/发送媒体 -> 去除来源
      // 按优先级精准匹配，只触发一次发送，防止一条视频触发 3 次响应
      const isVideoNote = !!msg.video_note
      const hasMainMedia = msg.video || msg.photo || msg.document || msg.animation || isVideoNote

      if (hasMainMedia) {
        const payload = {
          chat_id: msg.chat.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id
        }

        // 只有非圆视频且自带文案时保留文案
        if (!isVideoNote && msg.caption) {
          payload.caption = msg.caption
        }

        const res = await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id,
            ...( !isVideoNote && msg.caption ? { caption: msg.caption } : {} )
          })
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
