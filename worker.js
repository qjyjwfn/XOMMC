export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    // 从 env 参数中提取 CF 后台设置的 TOKEN
    const token = env.TOKEN
    if (!token) {
      console.error('❌ 未在 env 中找到 TOKEN，请检查 CF 后台环境变量设置')
      return new Response('TOKEN is missing', { status: 500 })
    }

    try {
      const update = await request.json()
      const msg = update.message || update.channel_post

      if (msg) {
        const isVideoNote = !!msg.video_note
        const hasMedia = msg.video || msg.animation || isVideoNote || msg.photo || msg.document

        if (hasMedia) {
          const newCaption = (msg.reply_to_message && msg.reply_to_message.text)
            ? msg.reply_to_message.text
            : (msg.caption || "✅ 已去除转发来源")

          const payload = {
            chat_id: msg.chat.id,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
          }

          if (!isVideoNote) {
            payload.caption = newCaption
          }

          const res = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
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
}
