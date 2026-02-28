# Napcat QQ机器人配置

## QQ账号配置
qq_number: 123456789
qq_password: your_password_here

## 服务器配置
server_host: 127.0.0.1
server_port: 3000
api_key: your_api_key_here

## 群聊配置
group_718824969:
  name: "测试群"
  enable_auto_reply: true
  admin_users: [123456, 789012]
  
## 功能开关
enable_quotes: true
quotes_interval: 3600  # 秒
enable_auto_weather: false
enable_chatgpt: true

## 语录来源
quote_sources:
  - "预置语录库"
  - "网络API"
  - "自定义语录文件"

## 消息模板
quote_template: "📚 每日语录 {time}\n\n{quote}\n\n—— {author}"