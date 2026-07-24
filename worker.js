addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// 在 Worker 全局作用域记录媒体组 ID，拦截 Telegram 相册重复推送
const seenMediaGroups = new Set()

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

    // 场景 1：回复（Reply）Bot 刚才发出的视频，并发送纯文本 -> 修改其简介
    if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
      const targetMessageId = msg.reply_to_message.message_id
      
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageCaption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          message_id: targetMessageId,
          caption: msg.text
        })
      })

      const resData = await res.json()
      if (!resData.ok) {
        console.error('修改文案失败:', JSON.stringify(resData))
      }
      return new Response('OK')
    }

    // 场景 2：原样无痕转发媒体（彻底去除来源，保留原本格式与文案）
    const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document

    if (hasMedia) {
      // 【关键修复】：拦截媒体组/相册的重复推送，防止“回三条消息”
      if (msg.media_group_id) {
        if (seenMediaGroups.has(msg.media_group_id)) {
          // 已经处理过该组视频，直接丢弃后续的多余推送
          return new Response('OK')
        }
        // 没处理过，记录下来
        seenMediaGroups.add(msg.media_group_id)
        
        // 简单清理，防止长时间运行导致内存堆积
        if (seenMediaGroups.size > 50) {
          seenMediaGroups.delete(seenMediaGroups.values().next().value)
        }
      }

      // 使用 copyMessage 原样复制，只要不写 caption 参数，它就会 100% 继承原消息的文案
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
