import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { SkillInfo } from '../../../src/api/types.js';
import { useSkills } from './catalog.js';

export const RESTART_COMMAND: SkillInfo = { name: 'restart', description: 'hos: restart this chat on the same conversation' };

export function useSlash(text: string, setText: (next: string) => void, box: RefObject<HTMLTextAreaElement | null>, profile: string, commands: SkillInfo[] = []) {
  const skills = useSkills(profile);
  const [off, setOff] = useState(false);
  const [at, setAt] = useState(0);
  const hits = off ? [] : slashMatches(skills && [...commands, ...skills], text);
  const active = Math.min(at, hits.length - 1);
  const insert = (skill: SkillInfo) => {
    setText(`/${skill.name} `);
    setAt(0);
    box.current?.focus();
  };
  return {
    menu: hits.length > 0 ? <SlashMenu skills={hits} active={active} onPick={insert} /> : null,
    typed() {
      setAt(0);
      setOff(false);
    },
    key(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!hits.length || e.nativeEvent.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setAt((active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
      else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') insert(hits[active]!);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        setOff(true);
      } else return false;
      e.preventDefault();
      return true;
    },
  };
}

function slashMatches(skills: SkillInfo[] | undefined, text: string): SkillInfo[] {
  const query = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  if (query === undefined || !skills) return [];
  const hits = skills.filter((skill) => skill.name.toLowerCase().includes(query));
  return [...hits.filter((skill) => skill.name.toLowerCase().startsWith(query)), ...hits.filter((skill) => !skill.name.toLowerCase().startsWith(query))];
}

function SlashMenu({ skills, active, onPick }: { skills: SkillInfo[]; active: number; onPick: (skill: SkillInfo) => void }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <ul className="slash-menu" role="listbox" aria-label="Skills" ref={list}>
      {skills.map((skill, i) => (
        <li
          key={skill.name}
          role="option"
          aria-selected={i === active}
          onPointerDown={(e) => {
            e.preventDefault();
            onPick(skill);
          }}
        >
          <span className="slash-name">/{skill.name}</span>
          {skill.description && <span className="slash-desc">{skill.description}</span>}
        </li>
      ))}
    </ul>
  );
}
