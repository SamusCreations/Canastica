import React from 'react';
import { User, Users } from 'lucide-react';
import type { HouseholdMember } from '../types/grocery';

interface AssigneeSelectProps {
  members: HouseholdMember[];
  isShared: boolean;
  /** Owner of a personal item */
  assignedTo?: string;
  /** 'shared' or a member id */
  onChange: (value: string) => void;
  className?: string;
}

/** Who pays for a receipt line: the whole household, or one specific member. */
export const AssigneeSelect: React.FC<AssigneeSelectProps> = ({
  members,
  isShared,
  assignedTo,
  onChange,
  className = '',
}) => {
  const value = isShared ? 'shared' : assignedTo ?? '';
  return (
    <label
      className={`relative px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 shrink-0 ${
        isShared
          ? 'bg-avocado-500/15 text-avocado-600 dark:text-avocado-400'
          : 'bg-purple-500/15 text-purple-600 dark:text-purple-400'
      } ${className}`}
    >
      {isShared ? <Users className="w-3 h-3" /> : <User className="w-3 h-3" />}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none cursor-pointer max-w-[8.5rem] truncate"
        aria-label="Asignar producto"
      >
        <option value="shared">Compartido (hogar)</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            Personal: {m.name.split(' ')[0]}
          </option>
        ))}
      </select>
    </label>
  );
};
