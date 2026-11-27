import { useEffect, useState } from 'react';

export function NameText({ text, naming }: { text: string; naming: boolean }) {
  const [waited, setWaited] = useState(naming);
  useEffect(() => {
    if (naming) setWaited(true);
  }, [naming]);
  if (naming) {
    return (
      <span className="naming" role="status" aria-label="Naming…">
        <i />
        <i />
      </span>
    );
  }
  return <span className={waited ? 'named' : undefined}>{text}</span>;
}
