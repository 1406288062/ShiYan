// 常见邮箱的 IMAP / SMTP 服务器。都使用授权码或应用专用密码登录。
const SERVERS = {
  qq: { imap: 'imap.qq.com', smtp: 'smtp.qq.com', smtpPort: 465, label: 'QQ 邮箱' },
  163: { imap: 'imap.163.com', smtp: 'smtp.163.com', smtpPort: 465, label: '网易 163 邮箱' },
  126: { imap: 'imap.126.com', smtp: 'smtp.126.com', smtpPort: 465, label: '网易 126 邮箱' },
  yeah: { imap: 'imap.yeah.net', smtp: 'smtp.yeah.net', smtpPort: 465, label: '网易 yeah.net' },
  gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', smtpPort: 465, label: 'Gmail' },
  icloud: { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587, label: 'iCloud 邮件' },
  139: { imap: 'imap.139.com', smtp: 'smtp.139.com', smtpPort: 465, label: '139 邮箱' },
  sina: { imap: 'imap.sina.com', smtp: 'smtp.sina.com', smtpPort: 465, label: '新浪邮箱' },
  sohu: { imap: 'imap.sohu.com', smtp: 'smtp.sohu.com', smtpPort: 465, label: '搜狐邮箱' },
  aliyun: { imap: 'imap.aliyun.com', smtp: 'smtp.aliyun.com', smtpPort: 465, label: '阿里邮箱' },
};
const DOMAINS = {
  'qq.com': 'qq', 'vip.qq.com': 'qq', 'foxmail.com': 'qq',
  '163.com': 163, 'vip.163.com': 163, '126.com': 126, 'yeah.net': 'yeah',
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  '139.com': 139, 'sina.com': 'sina', 'sina.cn': 'sina', 'sohu.com': 'sohu', 'aliyun.com': 'aliyun',
};

export function mailServers(address: any) {
  const match = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)$/.exec(String(address || '').trim());
  if (!match) return null;
  const key = (DOMAINS as any)[match[1].toLowerCase()];
  return key === undefined ? null : { ...(SERVERS as any)[key], key: String(key) };
}

export const SUPPORTED_MAIL_LABELS = Object.values(SERVERS).map(s => s.label);
