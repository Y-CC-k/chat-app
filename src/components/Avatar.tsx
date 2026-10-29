interface AvatarProps {
  name: string
  color: string
  size?: number
}

/** 圓形頭像：暱稱／房間名第一個字 */
export function Avatar({ name, color, size = 40 }: AvatarProps) {
  const char = [...name.trim()][0] ?? '?'
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {char}
    </span>
  )
}
