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
    if (!msg) return new Response('OK')

    // 场景 1：回复 Bot 发出的视频消息 -> 修改其简介/文案
    if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
      await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageCaption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: msg.reply_to_message.message_id,
          caption: msg.text
        })
      })
      return new Response('OK')
    }

    // 场景 2：原样无痕复制消息（抹去来源，原封不动保留原文案与格式）
    const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document

    if (hasMedia) {
      // 过滤媒体组重复请求
      if (msg.media_group_id && update.update_id % 2 !== 0) {
        return new Response('OK')
      }

      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id
        })
      })

      const resData = await res.json()
      if (!resData.ok) {
        console.error('Telegram API 返回错误:', JSON.stringify(resData))
      }
    }
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
