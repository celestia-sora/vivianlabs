-- Add covering indexes for unindexed foreign keys flagged by Supabase Performance Advisor.

create index if not exists memories_superseded_by_idx
  on public.memories (superseded_by);

create index if not exists memories_supersedes_id_idx
  on public.memories (supersedes_id);

create index if not exists vivian_model_expression_preferences_model_id_idx
  on public.vivian_model_expression_preferences (model_id);

create index if not exists vivian_scene_preferences_user_active_scene_idx
  on public.vivian_scene_preferences (user_id, active_scene_id);

create index if not exists vivian_storage_objects_category_idx
  on public.vivian_storage_objects (category);
