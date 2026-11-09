import { useEffect, useState } from 'react'
import { DEFAULT_TOOL_PREFERENCES, type ToolDefinition, type ToolPreferences } from '@shared/tools'
import { L } from '@shared/i18n'
import { Section, useApp } from '../App'
import { api, errMsg } from '../api'

export function ToolSettings() {
  const app = useApp()
  const [definitions, setDefinitions] = useState<ToolDefinition[]>([])
  useEffect(() => { void api.tools.list().then(setDefinitions).catch((e) => app.toast(errMsg(e), 'error')) }, [])
  const prefs = app.settings?.tools ?? DEFAULT_TOOL_PREFERENCES
  const update = (patch: Partial<ToolPreferences>) => { void app.updateSettings({ tools: { ...prefs, ...patch } }).catch((e) => app.toast(errMsg(e), 'error')) }
  return <Section title={L('ツール呼び出し', 'Tool calling')}>
    <label><input type="checkbox" checked={prefs.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> {L('チャットでツールを使用（初期値は無効）', 'Use tools in chat (disabled by default)')}</label>
    <p className="muted small">{L('対応するモデルとチャットテンプレートが必要です。LAN クライアントに実行権限は付与しません。', 'Requires a compatible model and chat template. LAN clients receive no execution privileges.')}</p>
    {definitions.map(({ function: tool }) => <div className="form-row" key={tool.name}>
      <label><input type="checkbox" checked={prefs.enabledTools[tool.name] === true} onChange={(e) => update({ enabledTools: { ...prefs.enabledTools, [tool.name]: e.target.checked } })} /> {tool.name}</label>
      <span className="muted small">{tool.name === 'web_search' ? L('DuckDuckGo/Bing で公開ウェブを検索します。検索語が外部へ送信されます。キー不要・初期値は無効です。', 'Search the public web through DuckDuckGo/Bing. Search queries leave this PC. No key required; disabled by default.') : tool.description}</span>
    </div>)}
    <div className="form-row"><label>{L('最大実行ラウンド', 'Maximum tool rounds')} <input type="number" min={1} max={8} value={prefs.maxRounds} onChange={(e) => update({ maxRounds: Number(e.target.value) })} /></label></div>
    <div className="form-row"><label>{L('ツールの制限時間（ミリ秒）', 'Tool timeout (milliseconds)')} <input type="number" min={100} max={30000} step={100} value={prefs.timeoutMs} onChange={(e) => update({ timeoutMs: Number(e.target.value) })} /></label></div>
  </Section>
}
