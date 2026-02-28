/** 从网络获取随机中文语录 */
export default async function run() {
  // 获取2条随机语录
  const quotes: string[] = [];
  
  for (let i = 0; i < 2; i++) {
    try {
      const response = await fetch('https://v1.hitokoto.cn/', {
        headers: {
          'User-Agent': 'n0n-workflow/1.0',
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`一言API错误: ${response.status}`);
      }
      
      const data = await response.json() as {
        hitokoto: string;
        from?: string;
        from_who?: string;
      };
      
      let quote = data.hitokoto;
      if (data.from_who) {
        quote += ` —— ${data.from_who}`;
      } else if (data.from) {
        quote += ` —— ${data.from}`;
      }
      
      quotes.push(quote);
      
      // 短暂延迟避免API限速
      if (i < 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`获取第${i + 1}条语录失败:`, error);
      quotes.push(`语录获取失败，请稍后再试`);
    }
  }
  
  return {
    quotes,
    source: 'hitokoto.cn',
    count: quotes.length
  };
}