import { useEffect } from 'react'
import { WindowControls, useWindowChrome } from './components/WindowControls'
import iconUrl from '../../../resources/brand.png'

/** This shell has only window controls; authorization lives in an isolated view. */
export function AuthWindow(): React.JSX.Element {
  const state = useWindowChrome()
  useEffect(() => {
    if (state) document.documentElement.dataset.theme = state.theme
  }, [state?.theme])
  return (
    <div className="auth-frame">
      <div className="titlebar auth-titlebar">
        <img className="auth-brand" src={iconUrl} alt="" />
        <span className="auth-title">{state?.title ?? 'AutoSign'}</span>
        <span className="auth-origin" title={state?.origin}>{state?.origin}</span>
        <div className="titlebar-drag" />
        <WindowControls />
      </div>
    </div>
  )
}
