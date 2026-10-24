export default function EmptyState({ title, detail }) {
  return <div className="empty-state"><div className="empty-icon">⌁</div><strong>{title}</strong><p>{detail}</p></div>
}
