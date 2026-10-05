import type { Profile } from '@floorspec/rules-engine';
import { api } from '../lib/api';

/** Jurisdiction profiles on the API (FLR-T-6.8): `/api/profiles` and a project's `/profile`. */

export interface ProfileRow {
  id: string;
  profile: Profile;
  createdAt: string;
  updatedAt: string;
  projects: { id: string; name: string }[];
}

export interface DefaultProfile {
  id: null;
  profile: Profile;
  /** `standard`: Rules 10.6's "Model Codes (latest)". `instance`: the operator's RULE_PROFILE. */
  source: 'standard' | 'instance';
  projects: { id: string; name: string }[];
}

export interface Profiles {
  default: DefaultProfile;
  profiles: ProfileRow[];
  notice: string;
}

export interface ProjectProfile {
  id: string | null;
  profile: Profile;
  default: boolean;
}

export const listProfiles = () => api.get<Profiles>('/api/profiles');
export const createProfile = (profile: Profile) => api.post<ProfileRow>('/api/profiles', { profile });
export const updateProfile = (id: string, profile: Profile) => api.put<ProfileRow>(`/api/profiles/${id}`, { profile });
export const deleteProfile = (id: string) => api.del(`/api/profiles/${id}`);
export const projectProfile = (projectId: string) => api.get<ProjectProfile>(`/api/projects/${projectId}/profile`);
export const chooseProfile = (projectId: string, profileId: string | null) => api.put<ProjectProfile>(`/api/projects/${projectId}/profile`, { profileId });
