export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    if (!env.TOKEN || !env.DB) {
      return new Response('Configuration missing', { status: 500 })
    }

    try {
      const update = await request.json()
      const msg = update.message || update.channel_post
      if (!msg) return new Response('OK')

      // 自动初始化数据库表
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS media_buffer (
          chat_id TEXT,
          message_id INTEGER,
          data TEXT,
          created_at INTEGER
        )
      `).run()

      // 场景 1：长按回复 Bot 发出的消息，并发送纯文本 -> 修改其简介/文案
      if (msg.reply_to_message && msg.text && !msg.video && !msg.photo && !msg.animation && !msg.document) {
        await fetch(`https://api.telegram.org/bot${env.TOKEN}/editMessageCaption`, {
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

      // 场景 2：时间窗聚合所有媒体消息（无论来源如何，1.5秒内的所有媒体强制打包）
      const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document
      if (hasMedia) {
        const now = Date.now()
        const chatIdStr = String(msg.chat.id)

        // 写入缓冲区
        await env.DB.prepare('INSERT INTO media_buffer (chat_id, message_id, data, created_at) VALUES (?, ?, ?, ?)')
          .bind(chatIdStr, msg.message_id, JSON.stringify(msg), now)
          .run()

        // 等待 1.5 秒，让同批次的所有并发请求全部写入数据库
        await new Promise(resolve => setTimeout(resolve, 1500))

        // 读取该聊天最近 3 秒内的所有媒体缓存
        const { results: rows } = await env.DB.prepare('SELECT message_id, data FROM media_buffer WHERE chat_id = ? AND created_at >= ? ORDER BY message_id ASC')
          .bind(chatIdStr, now - 3000)
          .all()

        if (!rows || rows.length === 0) return new Response('OK')

        // 选举机制：只允许本批次 message_id 最大的那一个实例执行发送，其余并发实例直接退出
        const maxId = Math.max(...rows.map(r => r.message_id))
        if (msg.message_id !== maxId) {
          return new Response('OK')
        }

        // 清理当前聊天的缓冲区
        await env.DB.prepare('DELETE FROM media_buffer WHERE chat_id = ?').bind(chatIdStr).run()

        const messages = rows.map(r => JSON.parse(r.data))
        messages.sort((a, b) => a.message_id - b.message_id)

        // 如果总共只有 1 条媒体，直接调用 copyMessage 单发
        if (messages.length === 1) {
          await fetch(`https://api.telegram.org/bot${env.TOKEN}/copyMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              from_chat_id: msg.chat.id,
              message_id: messages[0].message_id
            })
          })
          return new Response('OK')
        }

        // 如果有 2 条或以上（例如海报 + 视频），打包成相册通过 sendMediaGroup 一次性发出
        const mediaArray = []
        let globalCaption = ''

        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]
          if (m.caption && !globalCaption) {
            globalCaption = m.caption
          }

          let fileId = ''
          let type = 'photo'

          if (m.video) {
            fileId = m.video.file_id
            type = 'video'
          } else if (m.photo) {
            fileId = m.photo[m.photo.length - 1].file_id
            type = 'photo'
          } else if (m.document) {
            fileId = m.document.file_id
            type = 'document'
          } else if (m.animation) {
            fileId = m.animation.file_id
            type = 'animation'
          }

          if (fileId) {
            const mediaItem = { type, media: fileId }
            if (i === 0 && globalCaption) {
              mediaItem.caption = globalCaption
            }
            mediaArray.push(mediaItem)
          }
        }

        if (mediaArray.length > 0) {
          await fetch(`https://api.telegram.org/bot${env.TOKEN}/sendMediaGroup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              media: mediaArray
            })
          })
        }
      }
    } catch (err) {
      console.error('Worker 运行异常:', err.message)
    }

    return new Response('OK')
  }
}
