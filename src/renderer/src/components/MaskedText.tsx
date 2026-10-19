interface Props {
  /**
   * 原始值只用于推算遮罩宽度，不会渲染到 DOM。
   * 这样即使截图或查看元素也拿不到原文。
   */
  value?: string | null
  /** sm 用于标签、日志行内；md 用于账号名等主要位置。 */
  size?: 'sm' | 'md'
  className?: string
}

/** 遮罩宽度的字符数下限 / 上限：太短的空块看不出是遮罩，太长的又会撑坏布局。 */
const MIN_UNITS = 5
const MAX_UNITS = 16

/**
 * 账号信息的遮罩块。
 *
 * 开启打码后不再显示「g******9」这类保留首尾字符的文本——那仍然泄露了
 * 一部分身份信息，截图分享时不够彻底。这里直接渲染一块灰条，
 * 宽度按原名长度估算，既能一眼看出「这里原本有内容」，又拿不到任何字符。
 */
export function MaskedText({ value, size = 'md', className }: Props): React.JSX.Element {
  const length = [...(value ?? '')].length || MIN_UNITS
  const units = Math.min(Math.max(length, MIN_UNITS), MAX_UNITS)
  const unitWidth = size === 'sm' ? 5 : 6.5

  return (
    <span
      className={`masked-text${size === 'sm' ? ' masked-text-sm' : ''}${
        className ? ` ${className}` : ''
      }`}
      style={{ width: Math.round(units * unitWidth) }}
      role="img"
      aria-label="账号信息已打码"
      title="账号打码已开启，关闭后可查看"
    />
  )
}
