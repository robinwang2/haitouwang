export type Uuid = string;

export type UserStatus = 'active' | 'suspended' | 'deletion_pending' | 'deleted';

export interface User {
  id: Uuid;
  email: string;
  display_name: string;
  locale: string;
  time_zone: string;
  status: UserStatus;
  version: number;
  created_at: string;
  updated_at: string;
}
