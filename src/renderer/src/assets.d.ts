/** 静态资源导入的类型声明（Vite 会把它们解析成 URL）。 */

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}
