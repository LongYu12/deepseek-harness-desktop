/** Copy dictionaries for the plugin store Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '插件商店',
  localeId: 'zh',
  loading: '正在读取插件商店…',
  error: '暂时无法读取插件商店。',
  retry: '重试',
  search: '搜索插件',
  catalog: '插件商店',
  installed: '已安装',
  entries: '已加载条目',
  empty: '暂无可用插件。',
  emptySearch: '没有匹配的插件。',
  install: '安装',
  installing: '安装中…',
  installedTag: '已安装',
  update: '更新',
  updating: '更新中…',
  uninstall: '卸载',
  uninstalling: '卸载中…',
  enable: '启用',
  disable: '停用',
  toggling: '切换中…',
  version: '版本',
  unknownVersion: '未知',
  restartHint: '有插件变更需要重启 dsh 后生效。',
  mutationFailed: '插件操作失败。',
} satisfies Record<string, string>

/** Plugin store locale key union. */
export type PluginStoreLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Plugin store',
  localeId: 'en',
  loading: 'Reading the plugin store…',
  error: 'The plugin store is temporarily unavailable.',
  retry: 'Retry',
  search: 'Search plugins',
  catalog: 'Plugin store',
  installed: 'Installed',
  entries: 'Loaded entries',
  empty: 'No plugins are available.',
  emptySearch: 'No matching plugins.',
  install: 'Install',
  installing: 'Installing…',
  installedTag: 'Installed',
  update: 'Update',
  updating: 'Updating…',
  uninstall: 'Uninstall',
  uninstalling: 'Uninstalling…',
  enable: 'Enable',
  disable: 'Disable',
  toggling: 'Toggling…',
  version: 'Version',
  unknownVersion: 'Unknown',
  restartHint: 'A plugin change needs a dsh restart to take effect.',
  mutationFailed: 'The plugin operation failed.',
} satisfies Record<PluginStoreLocaleKey, string>
