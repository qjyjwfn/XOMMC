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

      if (!msg) {
        return new Response('OK')
      }


      // 初始化
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS album_queue (
          group_id TEXT,
          message_id INTEGER
        )
      `).run()


      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS album_lock (
          group_id TEXT PRIMARY KEY
        )
      `).run()



      // 回复修改简介
      if (
        msg.reply_to_message &&
        msg.text &&
        !msg.video &&
        !msg.photo &&
        !msg.animation &&
        !msg.document
      ) {

        await fetch(
          `https://api.telegram.org/bot${env.TOKEN}/editMessageCaption`,
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json'
            },
            body:JSON.stringify({
              chat_id:msg.chat.id,
              message_id:msg.reply_to_message.message_id,
              caption:msg.text
            })
          }
        )

        return new Response('OK')
      }




      // 媒体组
      if (msg.media_group_id) {

        const groupId = msg.media_group_id


        await env.DB.prepare(`
          INSERT INTO album_queue
          (group_id,message_id)
          VALUES (?,?)
        `)
        .bind(
          groupId,
          msg.message_id
        )
        .run()



        const lock =
          await env.DB.prepare(`
            INSERT OR IGNORE INTO album_lock(group_id)
            VALUES(?)
          `)
          .bind(groupId)
          .run()



        // 已经有其它请求处理
        if (
          lock.meta &&
          lock.meta.changes === 0
        ) {
          return new Response('OK')
        }



        // 等待album完整
        await new Promise(
          r=>setTimeout(r,3000)
        )



        const {
          results:rows
        } =
        await env.DB.prepare(`
          SELECT message_id
          FROM album_queue
          WHERE group_id=?
          ORDER BY message_id ASC
        `)
        .bind(groupId)
        .all()



        await env.DB.prepare(`
          DELETE FROM album_queue
          WHERE group_id=?
        `)
        .bind(groupId)
        .run()


        await env.DB.prepare(`
          DELETE FROM album_lock
          WHERE group_id=?
        `)
        .bind(groupId)
        .run()



        if (!rows.length) {
          return new Response('OK')
        }



        console.log(
          '复制消息:',
          rows.map(r=>r.message_id)
        )



        const result =
        await fetch(
          `https://api.telegram.org/bot${env.TOKEN}/copyMessages`,
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json'
            },
            body:JSON.stringify({

              chat_id:msg.chat.id,

              from_chat_id:msg.chat.id,

              message_ids:
                rows.map(
                  r=>r.message_id
                )

            })
          }
        )


        console.log(
          'copyMessages:',
          await result.text()
        )


        return new Response('OK')
      }




      // 单媒体
      const hasMedia =
        msg.video ||
        msg.video_note ||
        msg.photo ||
        msg.animation ||
        msg.document


      if (hasMedia) {


        await fetch(
          `https://api.telegram.org/bot${env.TOKEN}/copyMessage`,
          {
            method:'POST',
            headers:{
              'Content-Type':'application/json'
            },
            body:JSON.stringify({

              chat_id:msg.chat.id,

              from_chat_id:msg.chat.id,

              message_id:msg.message_id

            })
          }
        )

      }


    } catch(err) {

      console.error(
        'Worker运行异常:',
        err.message
      )

    }


    return new Response('OK')
  }
}