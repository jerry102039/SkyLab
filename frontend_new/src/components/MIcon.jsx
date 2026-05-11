export default function MIcon({ name, size = 20 }) {
  return (
    <span className="material-icons-outlined" style={{ fontSize: size, lineHeight: 1 }}>
      {name}
    </span>
  );
}
