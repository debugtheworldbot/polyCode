const translations: Record<string, Record<string, string>> = {
  en: {
    // App
    'app.title': 'CodexHub',
    'app.subtitle': 'AI Coding Assistant Hub',

    // Sidebar
    'sidebar.projects': 'Projects',
    'sidebar.addProject': 'Add Project',
    'sidebar.noProjects': 'No projects yet. Add a project to get started.',
    'sidebar.sessions': 'Sessions',
    'sidebar.newSession': 'New Session',
    'sidebar.noSessions': 'No sessions. Create one to start coding.',
    'sidebar.settings': 'Settings',

    // Session
    'session.codex': 'Codex',
    'session.claude': 'Claude Code',
    'session.gemini': 'Gemini',
    'session.rename': 'Rename',
    'session.delete': 'Delete',
    'session.stop': 'Stop',
    'session.running': 'Running',
    'session.idle': 'Idle',

    // Composer
    'composer.placeholder': 'Type your message...',
    'composer.send': 'Send',
    'composer.sending': 'Sending...',
    'composer.addImage': 'Add images',
    'composer.removeImage': 'Remove image',

    // Messages
    'messages.welcome': 'Start a conversation by typing a message below.',
    'messages.welcomeCodex': 'This is a Codex session. Codex will help you write and modify code.',
    'messages.welcomeClaude': 'This is a Claude Code session. Claude will help you with coding tasks.',
    'messages.noSession': 'Select or create a session to begin.',

    // Settings
    'settings.title': 'Settings',
    'settings.general': 'General',
    'settings.theme': 'Theme',
    'settings.themeLight': 'Light',
    'settings.themeDark': 'Dark',
    'settings.themeSystem': 'System',
    'settings.language': 'Language',
    'settings.langEn': 'English',
    'settings.langZh': '中文',
    'settings.langSystem': 'System',
    'settings.cli': 'CLI Configuration',
    'settings.codexPath': 'Codex Binary Path',
    'settings.claudePath': 'Claude Binary Path',
    'settings.pathPlaceholder': 'Leave empty for default',
    'settings.cliStatus': 'CLI Status',
    'settings.available': 'Available',
    'settings.notFound': 'Not Found',
    'settings.save': 'Save',
    'settings.saved': 'Settings saved!',

    // Dialog
    'dialog.selectFolder': 'Select Project Folder',
    'dialog.projectName': 'Project Name',
    'dialog.cancel': 'Cancel',
    'dialog.confirm': 'Confirm',
    'dialog.chooseProvider': 'Choose AI Provider',
    'dialog.deleteConfirm': 'Are you sure you want to delete this?',

    // Provider
    'provider.codex': 'OpenAI Codex',
    'provider.claude': 'Claude Code',
    'provider.codexDesc': 'Powered by OpenAI Codex CLI with app-server protocol',
    'provider.claudeDesc': 'Powered by Anthropic Claude Code CLI',
  },
  zh: {
    // App
    'app.title': 'CodexHub',
    'app.subtitle': 'AI 编程助手中心',

    // Sidebar
    'sidebar.projects': '项目',
    'sidebar.addProject': '添加项目',
    'sidebar.noProjects': '暂无项目。添加一个项目开始使用。',
    'sidebar.sessions': '会话',
    'sidebar.newSession': '新建会话',
    'sidebar.noSessions': '暂无会话。创建一个开始编程。',
    'sidebar.settings': '设置',

    // Session
    'session.codex': 'Codex',
    'session.claude': 'Claude Code',
    'session.gemini': 'Gemini',
    'session.rename': '重命名',
    'session.delete': '删除',
    'session.stop': '停止',
    'session.running': '运行中',
    'session.idle': '空闲',

    // Composer
    'composer.placeholder': '输入消息...',
    'composer.send': '发送',
    'composer.sending': '发送中...',
    'composer.addImage': '添加图片',
    'composer.removeImage': '移除图片',

    // Messages
    'messages.welcome': '在下方输入消息开始对话。',
    'messages.welcomeCodex': '这是一个 Codex 会话。Codex 将帮助你编写和修改代码。',
    'messages.welcomeClaude': '这是一个 Claude Code 会话。Claude 将帮助你完成编程任务。',
    'messages.noSession': '选择或创建一个会话开始使用。',

    // Settings
    'settings.title': '设置',
    'settings.general': '通用',
    'settings.theme': '主题',
    'settings.themeLight': '浅色',
    'settings.themeDark': '深色',
    'settings.themeSystem': '跟随系统',
    'settings.language': '语言',
    'settings.langEn': 'English',
    'settings.langZh': '中文',
    'settings.langSystem': '跟随系统',
    'settings.cli': 'CLI 配置',
    'settings.codexPath': 'Codex 可执行文件路径',
    'settings.claudePath': 'Claude 可执行文件路径',
    'settings.pathPlaceholder': '留空使用默认路径',
    'settings.cliStatus': 'CLI 状态',
    'settings.available': '可用',
    'settings.notFound': '未找到',
    'settings.save': '保存',
    'settings.saved': '设置已保存！',

    // Dialog
    'dialog.selectFolder': '选择项目文件夹',
    'dialog.projectName': '项目名称',
    'dialog.cancel': '取消',
    'dialog.confirm': '确认',
    'dialog.chooseProvider': '选择 AI 提供商',
    'dialog.deleteConfirm': '确定要删除吗？',

    // Provider
    'provider.codex': 'OpenAI Codex',
    'provider.claude': 'Claude Code',
    'provider.codexDesc': '基于 OpenAI Codex CLI 的 app-server 协议',
    'provider.claudeDesc': '基于 Anthropic Claude Code CLI',
  },
};

let currentLanguage = 'en';

export function detectSystemLanguage(): string {
  const lang = navigator.language || 'en';
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export function setLanguage(lang: string) {
  if (lang === 'system') {
    currentLanguage = detectSystemLanguage();
  } else {
    currentLanguage = lang;
  }
}

export function getLanguage(): string {
  return currentLanguage;
}

export function t(key: string): string {
  const langDict = translations[currentLanguage] || translations['en'];
  return langDict[key] || translations['en'][key] || key;
}

// Initialize with system language
setLanguage('system');
