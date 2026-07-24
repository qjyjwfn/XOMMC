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


      // 初始化队列
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS album_queue (
          group_id TEXT,
          message_id INTEGER,
          from_chat_id TEXT,
          raw_data TEXT
        )
      `).run()


      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS album_lock (
          group_id TEXT PRIMARY KEY
        )
      `).run()



      // 回复 Bot 消息修改简介
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
        const chatId = msg.chat.id


        // 获取原频道ID
        let fromChatId = null


        if (msg.forward_from_chat) {

          fromChatId = msg.forward_from_chat.id

        }
        else if (msg.forward_origin?.chat) {

          fromChatId = msg.forward_origin.chat.id

        }



        await env.DB.prepare(`
          INSERT INTO album_queue
          (
            group_id,
            message_id,
            from_chat_id,
            raw_data
          )
          VALUES (?,?,?,?)
        `)
        .bind(
          groupId,
          msg.message_id,
          fromChatId,
          JSON.stringify(msg)
        )
        .run()



        // 抢锁
        const lock =
          await env.DB.prepare(`
            INSERT OR IGNORE INTO album_lock(group_id)
            VALUES(?)
          `)
          .bind(groupId)
          .run()



        if (
          lock.meta &&
          lock.meta.changes === 0
        ) {

          return new Response('OK')

        }



        // 等待同组消息
        await new Promise(
          r => setTimeout(r,1500)
        )



        const {
          results:rows
        } =
        await env.DB.prepare(`
          SELECT 
          message_id,
          from_chat_id
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



        const sourceChat =
          rows[0].from_chat_id



        console.log(
          '来源频道:',
          sourceChat,
          '消息:',
          rows.map(r=>r.message_id)
        )



        if (!sourceChat) {

          console.log(
            '没有获取到来源频道'
          )

          return new Response('OK')

        }



        const tgRes =
          await fetch(
            `https://api.telegram.org/bot${env.TOKEN}/forwardMessages`,
            {
              method:'POST',
              headers:{
                'Content-Type':'application/json'
              },
              body:JSON.stringify({

                chat_id:chatId,

                from_chat_id:sourceChat,

                message_ids:
                  rows.map(
                    r=>r.message_id
                  )

              })
            }
          )


        const tgText =
          await tgRes.text()


        console.log(
          'forwardMessages:',
          tgText
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