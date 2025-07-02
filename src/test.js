const {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const wikipedia = require("wikipedia");
require("dotenv").config();

// Configure FFmpeg from dependencies
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YT_API_KEY = process.env.YT_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Track ongoing processes
const activeProcesses = new Map();

// Helper functions
async function downloadMedia(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message);
  return "";
}

// Media processing functions
async function createVideoSticker(videoBuffer) {
  const tempDir = "./temp_stickers";
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `video_${timestamp}.mp4`);
  const outputPath = path.join(tempDir, `sticker_${timestamp}.webp`);

  try {
    fs.writeFileSync(inputPath, videoBuffer);

    // First check video duration
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        err ? reject(err) : resolve(data);
      });
    });

    const duration = metadata.format.duration;
    if (duration > 15) { // If video is longer than 15 seconds
      throw new Error("Video too long! Please send a video under 15 seconds.");
    }

    const targetDuration = Math.min(duration, 10); // Use full video if <10s, or first 10s

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          "-ignore_chapters 1",
          `-t ${targetDuration}` // Limit to first 10 seconds
        ])
        .outputOptions([
          "-vcodec libwebp",
          "-vf scale=512:512:force_original_aspect_ratio=decrease,fps=10,pad=512:512:-1:-1:color=white@0.0",
          "-loop 0",
          "-preset default",
          "-an",
          "-fps_mode vfr",
          "-s 512:512",
          "-quality 80",
          "-compression_level 6",
          "-fs 800K" // Increased size limit for better quality
        ])
        .on("start", cmd => console.log("Processing video:", cmd))
        .on("progress", progress => console.log("Progress:", progress.timemark))
        .on("error", reject)
        .on("end", resolve)
        .save(outputPath);
    });

    const stickerBuffer = fs.readFileSync(outputPath);
    return stickerBuffer;
  } catch (error) {
    console.error("Video sticker creation error:", error);
    throw new Error(error.message || "Failed to create sticker. Try with a shorter video (under 15 seconds).");
  } finally {
    // Clean up temp files
    [inputPath, outputPath].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
}

async function createImageSticker(imageBuffer, text = null) {
  const tempDir = "./temp_stickers";
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const outputPath = path.join(tempDir, `sticker_${Date.now()}.webp`);

  try {
    let image = sharp(imageBuffer)
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });

    if (text) {
      // For text stickers - make text bigger and centered
      const textSvg = Buffer.from(`
        <svg width="512" height="512">
          <!-- Main text with outline -->
          <text x="256" y="256" 
                font-family="Arial" 
                font-size="48" 
                fill="white" 
                text-anchor="middle"
                stroke="black"
                stroke-width="2"
                stroke-linejoin="round"
                font-weight="bold">
            ${text}
          </text>
        </svg>
      `);

      image = image.composite([{ input: textSvg, blend: 'over' }]);
    }

    await image.webp({ quality: 90 }).toFile(outputPath);

    return fs.readFileSync(outputPath);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
}

// Updated sticker command handler
async function handleStickerCommand(client, msg, isTextSticker = false) {
  const messageId = msg.key.id;
  if (activeProcesses.has(messageId)) return;
  activeProcesses.set(messageId, true);

  try {
    let mediaMessage = null;
    let isVideo = false;
    let text = null;

    // For text stickers, extract the text from the message
    if (isTextSticker) {
      const fullText = extractText(msg.message);
      // Better text extraction that handles quoted messages
      if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        // If replying to a message, take everything after the command
        text = fullText.split(' ').slice(1).join(' ');
      } else {
        // If not replying, take everything after the command
        text = fullText.substring(fullText.indexOf(' ') + 1);
      }
      
      if (!text || text.trim().length === 0) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Please provide text after the command. Example: !textsticker Hello World"
        });
      }
      
      // Limit text to 30 characters
      if (text.length > 30) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Text too long! Please keep it under 30 characters for stickers."
        });
      }
    }

    // Rest of your existing media detection code...
    // Check for media in current message
    if (msg.message.imageMessage) {
      mediaMessage = msg.message.imageMessage;
    } else if (msg.message.videoMessage) {
      mediaMessage = msg.message.videoMessage;
      isVideo = true;
    }

    // Check for media in quoted message
    if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage;
      if (quoted.imageMessage) {
        mediaMessage = quoted.imageMessage;
      } else if (quoted.videoMessage) {
        mediaMessage = quoted.videoMessage;
        isVideo = true;
      }
    }

    if (!mediaMessage) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: `❌ Please send or reply to an image/video with ${isTextSticker ? "!textsticker" : "!sticker"}`
      });
    }

    const mediaBuffer = await downloadMedia(mediaMessage, isVideo ? "video" : "image");
    
    // For text stickers, only allow images (not videos)
    if (isTextSticker && isVideo) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: "❌ Text stickers can only be created from images, not videos."
      });
    }

    const stickerBuffer = isVideo
      ? await createVideoSticker(mediaBuffer)
      : await createImageSticker(mediaBuffer, isTextSticker ? text : null);

    await client.sendMessage(msg.key.remoteJid, {
      sticker: stickerBuffer,
      caption: isVideo 
        ? "✅ Sticker created from first 10 seconds of video!" 
        : (isTextSticker ? "✅ Text sticker created!" : "")
    });

  } catch (error) {
    console.error("Sticker error:", error);
    await client.sendMessage(msg.key.remoteJid, {
      text: `❌ ${error.message || "Failed to create sticker. Please try again."}`
    });
  } finally {
    activeProcesses.delete(messageId);
  }
}

async function handleStickerCommand(client, msg, isTextSticker = false) {
  const messageId = msg.key.id;
  if (activeProcesses.has(messageId)) return;
  activeProcesses.set(messageId, true);

  try {
    let mediaMessage = null;
    let isVideo = false;
    let text = null;

    // For text stickers, extract the text from the message
    if (isTextSticker) {
      const fullText = extractText(msg.message);
      const parts = fullText.split(' ').filter(p => p.trim().length > 0);
      text = parts.slice(1).join(' ').trim();
      
      if (!text) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Please provide text after the command. Example: !textsticker Hello World"
        });
      }
      
      if (text.length > 30) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Text too long! Please keep it under 30 characters for stickers."
        });
      }
    }

    // Improved media detection
    const getMediaMessage = (message) => {
      if (!message) return null;
      
      if (message.imageMessage) return { message: message.imageMessage, type: 'image' };
      if (message.videoMessage) return { message: message.videoMessage, type: 'video' };
      if (message.extendedTextMessage?.contextInfo?.quotedMessage) {
        return getMediaMessage(message.extendedTextMessage.contextInfo.quotedMessage);
      }
      return null;
    };

    const mediaData = getMediaMessage(msg.message);
    if (!mediaData) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: `❌ Please send or reply to an image/video with ${isTextSticker ? "!textsticker" : "!sticker"}`
      });
    }

    mediaMessage = mediaData.message;
    isVideo = mediaData.type === 'video';

    // For text stickers, only allow images
    if (isTextSticker && isVideo) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: "❌ Text stickers can only be created from images, not videos."
      });
    }

    try {
      const mediaBuffer = await downloadMedia(mediaMessage, isVideo ? "video" : "image");
      const stickerBuffer = isVideo
        ? await createVideoSticker(mediaBuffer)
        : await createImageSticker(mediaBuffer, isTextSticker ? text : null);

      await client.sendMessage(msg.key.remoteJid, {
        sticker: stickerBuffer,
        caption: isVideo 
          ? "✅ Sticker created from first 10 seconds of video!" 
          : (isTextSticker ? "✅ Text sticker created!" : "")
      });
    } catch (downloadError) {
      console.error("Media download error:", downloadError);
      throw new Error("Failed to process the media. Please try again with a different image/video.");
    }

  } catch (error) {
    console.error("Sticker error:", error);
    await client.sendMessage(msg.key.remoteJid, {
      text: `❌ ${error.message || "Failed to create sticker. Please try again."}`
    });
  } finally {
    activeProcesses.delete(messageId);
  }
}

// Command handlers
async function handleChatCommand(client, msg, args) {
  const prompt = args.join(" ");
  if (!prompt) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !chat <prompt>" });

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );

    const aiReply = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "🤖 No response.";
    await client.sendMessage(msg.key.remoteJid, {
      text: `🤖 *AI Response:*\n\n${aiReply}`
    });
  } catch (err) {
    console.error("Gemini error:", err);
    client.sendMessage(msg.key.remoteJid, { text: "❌ Error with Gemini API." });
  }
}

async function handleWeatherCommand(client, msg, args) {
  const city = args.join(" ");
  if (!city) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !weather <city>" });

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${WEATHER_API_KEY}&units=metric`;
    const res = await axios.get(url);
    const { temp, humidity } = res.data.main;
    const desc = res.data.weather[0].description;

    await client.sendMessage(msg.key.remoteJid, {
      text: `🌤️ Weather in *${city}*\n🌡️ Temp: ${temp}°C\n💧 Humidity: ${humidity}%\n🌍 Condition: ${desc}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ City not found!" });
  }
}

async function handleWikiCommand(client, msg, args) {
  const query = args.join(" ");
  if (!query) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !wiki <query>" });

  try {
    const summary = await wikipedia.summary(query);
    await client.sendMessage(msg.key.remoteJid, {
      text: `📖 *Wikipedia: ${query}*\n\n${summary.extract}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ No results found!" });
  }
}

async function handleYTSearchCommand(client, msg, args) {
  const query = args.join(" ");
  if (!query) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !ytsearch <query>" });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${YT_API_KEY}`;
    const res = await axios.get(url);
    const video = res.data.items[0];
    const videoUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`;

    await client.sendMessage(msg.key.remoteJid, {
      text: `🎥 *Top Result for "${query}"*\n\n*${video.snippet.title}*\n${video.snippet.description.slice(0, 100)}...\n🔗 ${videoUrl}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ YouTube search failed." });
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const client = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  client.ev.on("creds.update", saveCreds);

  client.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    } else if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
    }
  });

  client.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    const body = extractText(msg.message);
    if (!body.startsWith("!")) return;

    const command = body.split(" ")[0];
    const args = body.split(" ").slice(1);

    if (command === "!menu" || command === "!help") {
      await client.sendMessage(msg.key.remoteJid, {
        text: `📌 *Bot Menu* 📌\n\n!help - Show help\n!weather <city>\n!wiki <query>\n!ytsearch <query>\n!chat <prompt>\n!sticker - Create sticker from image/video\n!textsticker - Create sticker with text (max 30 chars, images only)`
      });
    }
    else if (command === "!sticker") {
      await handleStickerCommand(client, msg, false);
    }
    else if (command === "!textsticker") {
      await handleStickerCommand(client, msg, true);
    }
    else if (command === "!chat") {
      await handleChatCommand(client, msg, args);
    }
    else if (command === "!weather") {
      await handleWeatherCommand(client, msg, args);
    }
    else if (command === "!wiki") {
      await handleWikiCommand(client, msg, args);
    }
    else if (command === "!ytsearch") {
      await handleYTSearchCommand(client, msg, args);
    }
  });
}

// Clean exit handler
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  try {
    if (fs.existsSync("./temp_stickers")) {
      fs.rmSync("./temp_stickers", { recursive: true });
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
  process.exit(0);
});

startSock().catch(err => {
  console.error("Bot startup failed:", err);
  process.exit(1);
});