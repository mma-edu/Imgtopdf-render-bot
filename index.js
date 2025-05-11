const { Telegraf } = require('telegraf');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const axios = require('axios'); // Replaced node-fetch with axios
const express = require('express');

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);

// ======================
// 1. INITIALIZATION CHECKS
// ======================
if (!process.env.BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}

// ======================
// 2. SESSION MANAGEMENT
// ======================
const userSessions = {};
const MAX_IMAGES = 50;

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    userSessions[userId] = { images: [] };
  }
  
  // Auto-clean old sessions (24h)
  if (userSessions[userId].timestamp && Date.now() - userSessions[userId].timestamp > 86400000) {
    delete userSessions[userId];
    return ctx.reply("⌛ Session expired. Send /start");
  }

  ctx.session = userSessions[userId];
  ctx.session.timestamp = Date.now();
  await next();
});

// ======================
// 3. BOT COMMANDS
// ======================
bot.command('start', (ctx) => {
  ctx.reply(
    "📸➡️📄 *Image to PDF Bot*\n\n" +
    "Send me images (JPEG/PNG) to convert to PDF!\n\n" +
    "• Max 50 images\n• Need to convert more than 50 images?\n• Visit our website for unlimited conversions:\n 👉 imagestopdf.vercel.app\n • /convert when ready\n• /cancel to clear\n• /help for instructions",
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', (ctx) => ctx.reply("Send images → /convert → Get PDF\nMax 50 images", { parse_mode: 'Markdown' }));
bot.command('cancel', (ctx) => {
  ctx.session.images = [];
  ctx.reply("🗑️ Cleared all images!");
});

// ======================
// 4. IMAGE PROCESSING
// ======================
async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data, 'binary');
}

async function processImage(ctx, file) {
  try {
    if (ctx.session.images.length >= MAX_IMAGES) {
      return ctx.reply(`⚠️ Max ${MAX_IMAGES} images reached. Use /convert now.`);
    }

    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const imageBuffer = await downloadImage(fileUrl.href);
    
    const processedImage = await sharp(imageBuffer)
      .resize(1200, 1200, { fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer();

    ctx.session.images.push(processedImage);
    ctx.reply(`✅ Added image /convert (${ctx.session.images.length}/${MAX_IMAGES})`);
  } catch (error) {
    console.error("Image error:", error);
    ctx.reply("❌ Failed to process image. Try another file.");
  }
}

bot.on('photo', async (ctx) => {
  await processImage(ctx, ctx.message.photo.pop());
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const validTypes = ['image/jpeg', 'image/png'];
  if (validTypes.includes(doc.mime_type)) {
    await processImage(ctx, doc);
  } else {
    ctx.reply("⚠️ Only JPEG/PNG images supported");
  }
});

// ======================
// 5. PDF GENERATION
// ======================
bot.command('convert', async (ctx) => {
  if (!ctx.session.images?.length) {
    return ctx.reply("⚠️ No images to convert");
  }

  ctx.reply("⏳ Creating PDF...");

  try {
    const pdfDoc = new PDFDocument({ margin: 0 });
    const chunks = [];
    let pdfSize = 0;

    pdfDoc.on('data', chunk => {
      chunks.push(chunk);
      pdfSize += chunk.length;
      if (pdfSize > 45 * 1024 * 1024) { // Stay under 50MB
        throw new Error("PDF too large - try fewer images");
      }
    });

    for (const imgBuffer of ctx.session.images) {
      const img = await sharp(imgBuffer)
        .resize(800, 800, { fit: 'inside' })
        .toBuffer();
      pdfDoc.image(img, 0, 0, { width: 595, height: 842 }); // A4 size
      if (ctx.session.images.indexOf(imgBuffer) < ctx.session.images.length - 1) {
        pdfDoc.addPage();
      }
    }

    await new Promise(resolve => {
      pdfDoc.on('end', resolve);
      pdfDoc.end();
    });

    await ctx.replyWithDocument({
      source: Buffer.concat(chunks),
      filename: `images_${Date.now()}.pdf`
    });

    ctx.session.images = [];
  } catch (error) {
    console.error("PDF error:", error);
    ctx.reply(`❌ PDF failed: ${error.message}\nTry with fewer images.`);
  }
});

// ======================
// 6. SERVER SETUP (RENDER)
// ======================
app.use(express.json());
app.post('/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  if (process.env.RENDER) {
    const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook`;
    bot.telegram.setWebhook(webhookUrl)
      .then(() => console.log(`Webhook set: ${webhookUrl}`))
      .catch(err => console.error("Webhook error:", err));
  }
});

// ======================
// 7. ERROR HANDLING
// ======================
bot.catch((err, ctx) => {
  console.error(`Bot error:`, err);
  ctx.reply("❌ Bot error. Try again later.");
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down');
  bot.stop();
  process.exit(0);
});