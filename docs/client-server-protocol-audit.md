# Сверка локального сервера с клиентским протоколом

Сверка исходников `src/client/game/Messages.ts`, `GameClient.ts`, `GameMessages.ts`,
`messageProcessor.ts`, `GameServerClient.ts`, `SIHostClient.ts` с `server/src/game/game.ts`,
`server/src/hubs` и `server/src/api/routes.ts`. Это инвентаризация реализаций, а не доказательство
полной совместимости с десктопной SI: часть путей и типы вопросов требуют сквозных проверок.

## Клиент → игровой сервер (`SendMessage`)

| Команда | Состояние в локальном сервере |
|---|---|
| `INFO`, `READY`, `START`, `CHOICE`, `I`, `ANSWER`, `ANSWER_VERSION`, `PASS` | Обрабатываются; для ответа и выбора проверяются текущая фаза и участник. Устная игра имеет отдельные правила. |
| `SETCHOOSER` | Управляющий задаёт активного игрока при выборе вопроса; старый запрос выбора отменяется. Не работает во время вопроса, финала и паузы. |
| `CONFIG` | `ADDTABLE`, `DELETETABLE`, `FREE`, `CHANGETYPE`, `SET`. Изменения состава во время вопроса откладываются до его окончания; финал не поддерживает изменения. `SET` не реализует полноценные перестановки людей. |
| `DELETE` | Только удаление тем финального раунда. |
| `VALIDATE` | Ручная проверка ответа в устной игре; в финале ручной проверки пока нет. |
| `ISRIGHT` | **Не соответствует формату клиента** (`ISRIGHT\n+/-\nкоэффициент`): направляется в обработчик `VALIDATE`, который ожидает ответ или индекс. Нужно раздельно реализовать подтверждение/апелляции. |
| `SET_STAKE` | Ограниченная ставка финала; аукционные вопросы обычного раунда пока не реализованы. |
| `MOVE` | `1` завершает текущий запланированный шаг (во время паузы игнорируется), `2` переходит к следующему раунду, `3` — к указанному раунду. Ручная проверка ответа живым ведущим не прерывается. |
| `PAUSE` | Останавливает серверные шаги и передаёт клиенту прошедшее время всех трёх таймеров; после снятия паузы они продолжают идти. |
| `SET_OPTIONS` | Реализовано подмножество настроек; неизвестные параметры не применяются. |
| `AVATAR` | Принимает `image`/`video`, рассылает и повторяет после `INFO2` для нового участника. |
| `ATOM` | Принимает окончание текущего видео/аудио **ответа** без заданной длительности, проверяя тип и адрес; в содержимом вопроса и HTML пока не управляет переходом. Есть резервный таймаут 180 секунд. |
| `MEDIALOADED` | Игнорируется. |
| `MEDIA_PRELOAD_PROGRESS` | Ограничивается 0–100 и транслируется участникам. |
| `MOVEABLE` | Возвращает фиксированный `CONTENT_STATE`, полноценной семантики moveable нет. |
| `PIN` | Возвращает локальный PIN. |
| `SETJOINMODE` | Игнорируется; запрет зрителей и пароль задаются при создании комнаты отдельно. |
| `BAN`, `UNBAN`, `CHANGE`, `SETHOST`, `TOGGLE`, `MARK`, `REPORT`, `LEADERBOARD`, `APELLATE` | Не реализованы; теперь не перенаправляются ошибочно в обработчик аватара. |
| `SELECT_PLAYER` | Не реализована. Нужна для специальных вопросов и выбора отвечающего. |

Сервер также принимает `STAKE` как альтернативу `SET_STAKE`; этот вариант клиентский `GameClient` не отправляет.

## Игровой сервер → клиент

По статическому использованию `GameMessage` сервер посылает `ANSWER`, `ANSWERS`, `ASK_STAKE`,
`ASK_VALIDATE`, `AVATAR`, `CANCEL`, `CHOICE`, `CHOOSE`, `CONFIG`, `CONNECTED`, `CONTENT2`,
`CONTENT_STATE`, `DISCONNECTED`, `ENDTRY`, `FINALTHINK`, `GAMEMETADATA`, `GAME_STATISTICS`,
`HOSTNAME`, `INFO2`, `LAYOUT`, `MEDIA_PRELOAD_PROGRESS`, `OPTIONS2`, `ORAL_ANSWER`, `OUT`,
`PACKAGE`, `PASS`, `PAUSE`, `PERSON`, `PERSONFINALSTAKE`, `PERSONSTAKE`, `PIN`, `PLAYER_ANSWER`,
`PLAYER_COUNT`, `PLAYER_STATE`, `QTYPE`, `QUESTION`, `QUESTIONCAPTION`, `QUESTION_END`, `READY`,
`REPLIC`, `RIGHTANSWER`, `ROUNDCONTENT`, `ROUNDSNAMES`, `ROUND_END`, `ROUND_THEMES2`,
`SETCHOOSER`, `SETJOINMODE`, `SHOWTABLO`, `STAGE`, `STOP`, `SUMS`, `TABLO2`, `THEME`, `TIMER`,
`TRY`, `WINNER`. Клиент объявляет и обрабатывает эти имена, но это не гарантирует совпадения всей семантики.

Отдельное расхождение: сервер отправляет `PERSONFINALANSWER`, но в `GameMessages.ts` и обработчике
клиента такого сообщения нет. Клиент также знает ряд сообщений, которые локальный сервер сейчас не
посылает: `ASK_SELECT_PLAYER`, `VALIDATION2`, `APPELLATION`, `QUESTION_ANSWERS`, сведения об авторах
и источниках, `TOGGLE`, `BANNED`, `PLAYER_SCORE_CHANGED`, `CONTENT_APPEND`, `RIGHT_ANSWER_START` и др.
Это ограничивает специальные вопросы, ручную проверку финала, управление и полноту отображения пакета.

## SignalR и HTTP

* Клиент `SIHostClient` вызывает `TryGetGameInfo`, `JoinGame2`, `SendMessage` — все три реализованы
  хабом `sihost`; обратные вызовы `Receive`, `Disconnect`, `GamePersonsChanged` присутствуют в клиенте.
  Возврат после разрыва возможен, пока в комнате остался другой человек; пустая комната удаляется.
* `GameServerClient` вызывает `GetGamesSlice` в `sionline` и получает `GameCreated`, `GameChanged`,
  `GameDeleted`; сервер реализует эти имена. HTTP `info/bots`, `info/host`, `info/storage-filter`,
  `POST games`, `POST games/auto`, `GET games?pin=…` имеют локальные маршруты.
* Загрузка и получение пакетов/аватаров и раздача `/package/...` реализованы локальным сервисом.
  Внешние хранилища, идентификация, приватность, статистика и некоторые параметры создания игры
  не эквивалентны полному SIOnline; см. `local-server.md` и `server-vs-desktop-audit.md`.
