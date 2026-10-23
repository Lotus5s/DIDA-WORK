export function DidaMark({
  className = 'h-10 w-10',
  title = 'DIDA',
}: {
  className?: string
  title?: string
}) {
  return (
    <svg viewBox="0 0 40 40" role="img" aria-label={title} className={className}>
      <rect x="1" y="1" width="38" height="38" rx="10" fill="#111111" />
      <path
        d="M12 10.5H20C27 10.5 30.5 14 30.5 20S27 29.5 20 29.5H12V10.5Z"
        fill="none"
        stroke="#f4f6f2"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 17H21M8 23H18"
        stroke="#50c7b8"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
