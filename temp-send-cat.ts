import { createFeishuClient, sendImage } from './workflows/skills/feishu-bot/scripts/lib.ts';
import { readFileSync } from 'fs';

async function sendCatImage() {
  try {
    const client = createFeishuClient();
    const imagePath = 'C:\\Users\\asus\\cute-cat-3i5-2026-03-03T06-43-09-712Z.jpg';
    const imageBuffer = readFileSync(imagePath);
    
    // 直接使用飞书客户端上传图片
    const uploadResult = await client.im.image.create({
      image: imageBuffer,
      image_type: 'message'
    });
    const imageKey = uploadResult.data.image_key;
    
    // 发送图片到指定聊天窗口
    await sendImage(client, {
      chat_id: 'oc_9e01ab1e37e42140fbfde30cf085909a',
      imageKey: imageKey
    });
    console.log('猫猫图片已成功发送到飞书！');
  } catch (error) {
    console.error('发送图片失败：', error);
    process.exit(1);
  }
}

sendCatImage();