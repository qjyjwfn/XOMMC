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

    // 场景 1：回复机器人消息 -> 修改简介/文案
    if (msg.reply_to_message && msg.text && !msg.video && !msg.photo) {
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

    // 场景 2：转发视频去来源
    // 🔒 严格限制：只对纯视频(video)或圆视频(video_note)响应，彻底剔除 photo / document / animation
    const isVideo = !!msg.video
    const isVideoNote = !!msg.video_note

    if (isVideo || isVideoNote) {
      // 如果属于媒体组（相册/多视频），只留第一条或者忽略，防止重复
      if (msg.media_group_id && msg.forward_from_message_id && msg.message_id !== msg.forward_from_message_id) {
        // 跳过媒体组后续推送
      }

      const payload = {
        chat_id: msg.chat.id,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id
      }

      // 只有非圆视频且有文案时保留文案
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
  } catch (err) {
    console.error('Worker 运行异常:', err.message)
  }

  return new Response('OK')
}
