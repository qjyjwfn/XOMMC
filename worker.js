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

      // 自动初始化队列与锁表
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS album_queue (group_id TEXT, message_id INTEGER, raw_data TEXT)`).run()
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS album_lock (group_id TEXT PRIMARY KEY)`).run()

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

      // 场景 2：处理多媒体相册（海报 + 视频组合）
      if (msg.media_group_id) {
        const groupId = msg.media_group_id
        const chatId = msg.chat.id

        // 1. 将当前消息存入队列
        await env.DB.prepare('INSERT INTO album_queue (group_id, message_id, raw_data) VALUES (?, ?, ?)')
          .bind(groupId, msg.message_id, JSON.stringify(msg))
          .run()

        // 2. 尝试抢占原子独占锁
        const lockRes = await env.DB.prepare('INSERT OR IGNORE INTO album_lock (group_id) VALUES (?)')
          .bind(groupId)
          .run()

        // 如果锁已被其他并发实例抢走，说明当前实例直接静默退出，交给主实例统一打包
        if (lockRes.meta && lockRes.meta.changes === 0) {
          return new Response('OK')
        }

        // 3. 稳妥等待 1.5 秒，让同批次的所有并发相册元素全部写入数据库
        await new Promise(resolve => setTimeout(resolve, 1500))

        // 4. 获取该相册组的所有媒体数据
        const { results: rows } = await env.DB.prepare('SELECT raw_data FROM album_queue WHERE group_id = ? ORDER BY message_id ASC')
          .bind(groupId)
          .all()

        // 5. 清理队列与锁
        await env.DB.prepare('DELETE FROM album_queue WHERE group_id = ?').bind(groupId).run()
        await env.DB.prepare('DELETE FROM album_lock WHERE group_id = ?').bind(groupId).run()

        if (!rows || rows.length === 0) return new Response('OK')

        const messages = rows.map(r => JSON.parse(r.raw_data))
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

        // 6. 一次性打包发送完美相册
        if (mediaArray.length > 0) {
          await fetch(`https://api.telegram.org/bot${env.TOKEN}/sendMediaGroup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              media: mediaArray
            })
          })
        }

        return new Response('OK')
      }

      // 场景 3：单条媒体消息（无相册分组）
      const hasMedia = msg.video || msg.video_note || msg.photo || msg.animation || msg.document
      if (hasMedia) {
        await fetch(`https://api.telegram.org/bot${env.TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
          })
        })
      }
    } catch (err) {
      console.error('Worker 运行异常:', err.message)
    }

    return new Response('OK')
  }
}
