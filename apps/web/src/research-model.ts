import type { GeoEvent, SectorNote, StudyCompany, StudySeries } from "@invest/domain";
export interface StudyBoard { events: GeoEvent[]; notes: SectorNote[]; companies: StudyCompany[] }
export interface StudyData { data: Record<string, StudySeries>; busy: string[]; errors: Record<string, string>; load: (id: string, refresh?: boolean) => Promise<void> }
