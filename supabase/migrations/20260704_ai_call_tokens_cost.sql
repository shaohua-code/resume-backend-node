-- AI 调用记录：token 用量与费用字段
alter table public.ai_call_record
  add column if not exists prompt_tokens int default 0,
  add column if not exists completion_tokens int default 0,
  add column if not exists total_tokens int default 0,
  add column if not exists cost numeric(10, 6) default 0;

-- AI 模型：每百万 token 输入/输出单价（元）
alter table public.ai_model
  add column if not exists input_price_per_million numeric(10, 4) default 0,
  add column if not exists output_price_per_million numeric(10, 4) default 0;

-- 为已有模型写入默认 DeepSeek 单价
update public.ai_model
set
  input_price_per_million = 0.5,
  output_price_per_million = 2.0
where model_key = 'deepseek-v4-flash'
  and (input_price_per_million = 0 or input_price_per_million is null);

update public.ai_model
set
  input_price_per_million = 2.0,
  output_price_per_million = 8.0
where model_key = 'deepseek-chat'
  and (input_price_per_million = 0 or input_price_per_million is null);
