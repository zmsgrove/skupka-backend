# 🚀 SKUPKA CRM — Инструкция по деплою

## Что у тебя будет после настройки:
- ✅ Канбан-доска с заявками по городам
- ✅ Бот в WhatsApp который собирает данные от клиентов
- ✅ Карточки создаются автоматически
- ✅ Переписка с клиентами прямо из CRM
- ✅ Realtime обновления

---

## ШАГ 1 — Supabase (база данных)

1. Зайди на https://supabase.com и войди в аккаунт
2. Нажми **New Project**, дай название "skupka-crm"
3. После создания зайди в **SQL Editor**
4. Вставь содержимое файла `supabase_schema.sql` и нажми **Run**
5. Зайди в **Settings → API Keys** и скопируй:
   - `Project URL` → это SUPABASE_URL
   - `anon public` → это SUPABASE_ANON_KEY (для фронтенда)
   - `service_role` → это SUPABASE_SERVICE_KEY (для бэкенда, держи в секрете!)

---

## ШАГ 2 — Wazzup (настройка канала)

1. Зайди в личный кабинет Wazzup
2. Зайди в **Каналы** → найди активный номер 77710837001
3. Скопируй **ID канала** (он указан в URL или настройках канала)
4. Зайди в **Настройки аккаунта → API**
5. Создай новый API ключ (старый уже пересоздан)

---

## ШАГ 3 — GitHub (загрузка кода)

### Бэкенд:
```
1. Создай новый репозиторий на GitHub — назови "skupka-backend"
2. Загрузи туда папку skupka-backend (все файлы кроме node_modules и .env)
```

### Фронтенд:
```
1. Создай новый репозиторий — назови "skupka-frontend"
2. Загрузи туда папку skupka-frontend (все файлы кроме node_modules и .env)
```

---

## ШАГ 4 — Render (деплой бэкенда)

1. Зайди на https://render.com
2. Нажми **New → Web Service**
3. Подключи репозиторий "skupka-backend"
4. Настройки:
   - **Name**: skupka-backend
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. В разделе **Environment Variables** добавь:

| Ключ | Значение |
|------|----------|
| SUPABASE_URL | https://твой_project_id.supabase.co |
| SUPABASE_SERVICE_KEY | твой service_role ключ |
| WAZZUP_API_KEY | твой новый API ключ Wazzup |
| WAZZUP_CHANNEL_ID | ID канала из Wazzup |

6. Нажми **Deploy** — дождись зелёного статуса
7. Скопируй URL сервера (вида: https://skupka-backend.onrender.com)

---

## ШАГ 5 — Настройка вебхука в Wazzup

После деплоя бэкенда нужно сказать Wazzup куда слать сообщения.

Открой в браузере или в Postman:
```
POST https://skupka-backend.onrender.com/setup-webhook
Body (JSON):
{
  "webhookUrl": "https://skupka-backend.onrender.com/webhook"
}
```

Или просто напиши мне — я помогу это сделать через curl.

---

## ШАГ 6 — Render (деплой фронтенда)

1. Нажми **New → Static Site**
2. Подключи репозиторий "skupka-frontend"
3. Настройки:
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `build`
4. В разделе **Environment Variables** добавь:

| Ключ | Значение |
|------|----------|
| REACT_APP_SUPABASE_URL | https://твой_project_id.supabase.co |
| REACT_APP_SUPABASE_ANON_KEY | твой anon public ключ |
| REACT_APP_BACKEND_URL | https://skupka-backend.onrender.com |

5. Нажми **Deploy**
6. Через 2-3 минуты получишь URL типа: https://skupka-frontend.onrender.com

---

## ШАГ 7 — Keep-alive (чтобы бэкенд не засыпал)

На бесплатном Render бэкенд засыпает через 15 минут. Чтобы это исправить:

1. Зайди на https://cron-job.org (бесплатно)
2. Зарегистрируйся
3. Создай новый cron job:
   - URL: `https://skupka-backend.onrender.com/ping`
   - Schedule: каждые 10 минут
4. Сохрани

---

## ✅ Готово! Логины для входа:

| Логин | Пароль | Доступ |
|-------|--------|--------|
| admin | Qwerty662026 | Все города |
| oral | Oral1234 | Только Уральск |
| aktobe | Aktobe4444 | Только Актобе |
| atytay | Atyray1111 | Только Атырау |

---

## Как это работает:

1. Клиент пишет на номер 77710837001
2. Бот автоматически собирает: имя → город → техника
3. Карточка появляется в нужном городе на канбан-доске
4. Сотрудник видит карточку, открывает её, ставит оценку
5. Нажимает "Отправить оценку клиенту" → клиент получает сообщение в WhatsApp
6. Дальше переписка идёт прямо в CRM

---

## Если что-то не работает:

- Бот не отвечает → проверь что вебхук настроен (Шаг 5)
- Карточки не создаются → проверь WAZZUP_CHANNEL_ID в Render
- Realtime не работает → проверь что SQL schema запущена и Realtime включён
- Бэкенд не запускается → проверь Environment Variables в Render

Пиши — помогу разобраться с любым шагом! 🚀
