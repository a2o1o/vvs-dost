# MIT App Inventor setup

This project is designed so the App Inventor app talks only to your backend.

## Components to add in `ai2a.appinventor.mit.edu`

- `TextBox` named `PromptTextBox`
- `Button` named `AskButton`
- `Label` named `ReplyLabel`
- `Web` named `GatewayWeb`

## `Screen1.Initialize`

Set:

- `GatewayWeb.Url` to your backend, for example `https://your-server.example.com/api/chat`

## `AskButton.Click`

Use the `Web` component to issue a POST request.

Headers:

- `Content-Type: application/json`
- `x-app-token: YOUR_SHARED_APP_TOKEN`

Request body:

```json
{
  "message": "value from PromptTextBox.Text",
  "userId": "some user identifier",
  "sessionId": "screen1"
}
```

In blocks, build the JSON text with `dictionary` blocks or text joins, then call `GatewayWeb.PostText`.

## `GatewayWeb.GotText`

Parse the JSON response and set:

- `ReplyLabel.Text` to `reply`

If the response contains `error`, show that instead.

## Important note

Do not place your OpenAI API key in App Inventor. The app should only know the backend URL and the shared app token.
