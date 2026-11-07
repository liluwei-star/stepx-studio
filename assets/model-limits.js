/*
 * model-limits.js —— 模型上下文长度限制
 * ================================================================
 *
 * 不同模型能接收的上下文长度不一样。超了要么被服务端直接拒绝，
 * 要么被悄悄截断导致回答质量暴跌。
 *
 * 这里在发请求前先按模型的实际上限做检查，把问题提前拦住，
 * 免得用户等半天才发现内容被砍掉了。
 * ================================================================
 */
'use strict';
function modelLimits(p={}){let official=false;try{const u=new URL(p.endpoint);official=u.protocol==='https:'&&u.hostname.toLowerCase()==='api.deepseek.com'&&['deepseek-flash','deepseek-v4-flash','deepseek-v4-pro','deepseek-v4-flash-vision-exp'].includes(p.model)}catch{}return {official,context:official?1048576:0,output:official?393216:32768,chars:official?8*1048576:95000}}
function refreshModelLimits(){const p={endpoint:$('#endpoint').value.trim(),model:$('#model').value.trim()},l=modelLimits(p);$('#maxTokens').max=l.output;$('#contextLimit').textContent=l.official?'上下文：1,048,576 Token（官方上限，包含输入与输出）。单次输出可设至393,216 Token；不按字符估算实际用量。':'上下文由服务商模型决定；单次输出上限与上下文窗口分别计算。';}
