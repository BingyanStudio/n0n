/** 获取随机语录并发送到指定QQ群 */
export default async function run() {
  // 从配置文件读取Napcat配置
  const configText = await Bun.file('napcat-config.md').text();
  const config: Record<string, string> = {};
  
  for (const line of configText.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      config[match[1].trim()] = match[2].trim();
    }
  }
  
  const serverHost = config.server_host || '127.0.0.1';
  const serverPort = parseInt(config.server_port || '9881');
  const token = config.token || '';
  
  console.log(`Napcat配置: ${serverHost}:${serverPort}`);
  
  // 获取2条不同的随机语录
  const quotes: string[] = [];
  const seenQuotes = new Set<string>();
  
  while (quotes.length < 2) {
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
      
      // 避免重复语录
      if (!seenQuotes.has(quote)) {
        seenQuotes.add(quote);
        quotes.push(quote);
      } else if (quotes.length === 0) {
        // 如果第一条就重复，仍然添加，但尝试获取不同的下一条
        quotes.push(quote);
      }
      
      // 避免无限循环
      if (seenQuotes.size > 10) {
        quotes.push(quote); // 强制添加
      }
      
      // 短暂延迟避免API限速
      if (quotes.length < 2) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) {
      console.error(`获取语录失败:`, error);
      if (quotes.length === 0) {
        quotes.push(`语录获取失败，请稍后再试`);
      }
      break;
    }
  }
  
  console.log('获取到的语录:', quotes);
  
  // 尝试通过WebSocket发送消息到Napcat
  try {
    // 尝试不同的WebSocket路径
    const wsUrls = [
      `ws://${serverHost}:${serverPort}/`,
      `ws://${serverHost}:${serverPort}/ws`,
      `ws://${serverHost}:${serverPort}/ws/`
    ];
    
    let ws: WebSocket | null = null;
    let connected = false;
    
    for (const wsUrl of wsUrls) {
      console.log(`尝试连接WebSocket: ${wsUrl}`);
      
      try {
        ws = new WebSocket(wsUrl);
        
        // 等待连接建立
        const success = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            resolve(false);
          }, 3000);
          
          ws!.onopen = () => {
            clearTimeout(timeout);
            console.log(`WebSocket连接成功: ${wsUrl}`);
            resolve(true);
          };
          
          ws!.onerror = () => {
            clearTimeout(timeout);
            resolve(false);
          };
        });
        
        if (success) {
          connected = true;
          break;
        } else {
          ws.close();
        }
      } catch (error) {
        console.log(`连接 ${wsUrl} 失败:`, error);
        continue;
      }
    }
    
    if (!connected || !ws) {
      throw new Error('无法连接到Napcat WebSocket服务');
    }
    
    console.log('WebSocket连接成功，准备发送消息');
    
    // 发送消息到群聊
    const groupId = 718824969;
    const results = [];
    
    for (const quote of quotes) {
      const messageData = {
        action: 'send_group_msg',
        params: {
          group_id: groupId,
          message: quote
        },
        echo: `quote_${Date.now()}`
      };
      
      ws.send(JSON.stringify(messageData));
      console.log(`已发送语录到群 ${groupId}: ${quote.substring(0, 50)}...`);
      
      // 等待响应
      const response = await new Promise<any>((resolve) => {
        const handler = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.echo === messageData.echo) {
              ws.removeEventListener('message', handler);
              resolve(data);
            }
          } catch (e) {
            // 忽略解析错误
          }
        };
        ws.addEventListener('message', handler);
        
        // 5秒超时
        setTimeout(() => {
          ws.removeEventListener('message', handler);
          resolve({ status: 'timeout', retcode: -1 });
        }, 5000);
      });
      
      results.push({
        quote,
        response: response.retcode === 0 ? '成功' : `失败 (代码: ${response.retcode})`
      });
      
      // 发送间隔
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // 关闭连接
    ws.close();
    
    return {
      success: true,
      quotes,
      results,
      groupId,
      sentCount: quotes.length
    };
    
  } catch (error) {
    console.error('发送消息失败:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      quotes,
      groupId: 718824969
    };
  }
}