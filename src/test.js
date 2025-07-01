const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const axios = require("axios");
const sharp = require("sharp");
const wikipedia = require("wikipedia");
const qrcode = require("qrcode-terminal");
require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YT_API_KEY = process.env.YT_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message);
  return "";
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const client = makeWASocket({
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  client.ev.on("creds.update", saveCreds);

  client.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  client.ev.on("messages.upsert", async ({ messages, type }) => {
    let msg = messages[0];

    // Debug logs for every incoming message
    console.log("\n📩 Message received:");
    console.log(`🔹 RemoteJID: ${msg.key.remoteJid}`);
    console.log(`🔹 FromMe: ${msg.key.fromMe}`);
    console.log(`🔹 Participant: ${msg.key.participant || "N/A"}`);
    console.log(`🔹 Message type: ${Object.keys(msg.message || {})}`);
    console.log(`🔹 Message content: ${JSON.stringify(msg.message, null, 2)}`);

    if (!msg?.message) return;

    // Extract text from normal or ephemeral message
    const body = extractText(msg.message);

    if (!body.startsWith("!")) return;

    const sender = msg.key.remoteJid;
    const command = body.split(" ")[0];
    const args = body.split(" ").slice(1);

    if (command === "!menu") {
      await client.sendMessage(sender, {
        text: `📌 *Bot Menu* 📌

!help - Show help
!weather <city>
!wiki <query>
!yt <URL>
!ytsearch <query>
!chat <prompt>
!sticker (send image)`,
      });
    }

    else if (command === "!chat") {
      const prompt = args.join(" ");
      if (!prompt) return client.sendMessage(sender, { text: "❌ Usage: !chat <prompt>" });

      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            contents: [{ parts: [{ text: prompt }] }]
          }
        );

        const aiReply =
          res.data.candidates?.[0]?.content?.parts?.[0]?.text ||
          "🤖 No response.";
        await client.sendMessage(sender, {
          text: `🤖 *AI Response:*\n\n${aiReply}`
        });
      } catch (err) {
        console.error("Gemini error:", err.response?.data || err);
        client.sendMessage(sender, { text: "❌ Error with Gemini API." });
      }
    }

    else if (command === "!weather") {
      const city = args.join(" ");
      if (!city) return client.sendMessage(sender, { text: "❌ Usage: !weather <city>" });

      try {
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${WEATHER_API_KEY}&units=metric`;
        const res = await axios.get(url);
        const { temp, humidity } = res.data.main;
        const desc = res.data.weather[0].description;

        await client.sendMessage(sender, {
          text: `🌤️ Weather in *${city}*\n🌡️ Temp: ${temp}°C\n💧 Humidity: ${humidity}%\n🌍 Condition: ${desc}`
        });
      } catch {
        client.sendMessage(sender, { text: "❌ City not found!" });
      }
    }

    else if (command === "!wiki") {
      const query = args.join(" ");
      if (!query) return client.sendMessage(sender, { text: "❌ Usage: !wiki <query>" });

      try {
        const summary = await wikipedia.summary(query);
        await client.sendMessage(sender, {
          text: `📖 *Wikipedia: ${query}*\n\n${summary.extract}`
        });
      } catch {
        client.sendMessage(sender, { text: "❌ No results found!" });
      }
    }

    else if (command === "!ytsearch") {
      const query = args.join(" ");
      if (!query) return client.sendMessage(sender, { text: "❌ Usage: !ytsearch <query>" });

      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
        query
      )}&type=video&key=${YT_API_KEY}`;

      try {
        const res = await axios.get(url);
        const video = res.data.items[0];
        const videoUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`;
        await client.sendMessage(sender, {
          text: `🎥 *Top Result for "${query}"*\n\n*${video.snippet.title}*\n${video.snippet.description.slice(
            0,
            100
          )}...\n🔗 ${videoUrl}`
        });
      } catch {
        client.sendMessage(sender, { text: "❌ YouTube search failed." });
      }
    }

    else if (command === "!sticker") {
      try {
        let imageMessage = null;

        // Case 1: Direct image with caption "!sticker"
        if (msg.message.imageMessage && msg.message.imageMessage.caption?.startsWith("!sticker")) {
          imageMessage = msg.message.imageMessage;
        }

        // Case 2: Replying to an image with "!sticker"
        if (
          msg.message?.extendedTextMessage?.text?.startsWith("!sticker") &&
          msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
        ) {
          imageMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;
        }

        if (!imageMessage) {
          return client.sendMessage(sender, { text: "❌ Please send or reply to an image with *!sticker*" });
        }

        const stream = await downloadContentFromMessage(imageMessage, "image");
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        const webpPath = "./temp_sticker.webp";
        await sharp(buffer)
          .resize(512, 512, { fit: "contain" })
          .webp({ quality: 90 })
          .toFile(webpPath);

        const webpBuffer = fs.readFileSync(webpPath);

        await client.sendMessage(sender, {
          sticker: webpBuffer
        });

        fs.unlinkSync(webpPath);
      } catch (err) {
        console.error("Sticker error:", err);
        await client.sendMessage(sender, { text: "❌ Failed to create sticker. Please try again." });
      }
    }

  });
}

startSock();