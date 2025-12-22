// server.js

const express = require("express");
const https = require("https");
const ws = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { deprecate } = require("util");

const app = express();

// --- HTTPS CONFIGURATION ---
const isProduction = process.env.NODE_ENV === "production";

let server;

if (isProduction) {
  // In production: The hosting provider handles SSL
  server = https.createServer(app);
} else {
  // Locally: Use self-signed certificates
  const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem"))
  };
  server = https.createServer(sslOptions, app);
}

const wss = new ws.Server({ server });
const port = 3000;


const pingIntervalDelay = 30 * 1000; // 30 seconds
let userIdsList = [];
let createdConversations = [];

const clients = new Map(); // Store data on connected clients

const publicPath = path.join(__dirname, '.', 'dist');
app.use(express.static(publicPath));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

let allMessages = [];
let messagesByConversations = {};

function createUserId() {
  let number = 1000;
  let userId = `User#${number}`;

  while (userIdsList.includes(userId)) {
    number++;
    userId = `User#${number}`;
  }

  return userId;
}

function getConversationKey(users) {
  return users.sort().join('|');
}

function arraysAreEqual(arr1, arr2) {
  // Detect if two arrays are the same length
  if (arr1.length !== arr2.length) return;

  // Detect if two arrays have the same values
  for (let i = 0; i < arr1.length; i++) {
    if (arr1.sort()[i] !== arr2.sort()[i]) return;
  }

  return true;
}

function generateBase36Token(length = 50) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let token = "";
  for (let i = 0; i < length; i++) {
    const idx = crypto.randomInt(0, alphabet.length); // 0-35
    token += alphabet[idx];
  }
  return token;
}

wss.on("connection", (socket) => {
  // console.log("A user connected");

  const pingInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  }, pingIntervalDelay);

  const userId = createUserId();
  const authToken = generateBase36Token(50);

  userIdsList.push(userId);

  // console.log(`User Authentication token`, authToken);

  clients.set(socket, { userId: userId, authToken: authToken, profileColour: `hsl(${Math.random() * 360}, 60%, 60%)`, conversations: [] });

  let conversations = clients.get(socket)?.conversations;

  conversations.push({ name: "Global Chat", users: "global-chat" });

  console.log(`User: ${userId} connected`);
  // console.log(userIdsList);

  socket.on("pong", () => {
    // console.log("Pong recieved from client");
  });

  socket.on("message", (message) => {
    const parsedMessage = JSON.parse(message);
    const payload = parsedMessage.data || {};
    console.log("Received:", parsedMessage);

    if (
      parsedMessage.type !== "ready" && // allow 'ready' messages without token
      payload.authToken !== clients.get(socket)?.authToken
    ) {
      console.log("Rejected message from unauthenticated client");
      return;
    }


    if (parsedMessage.type === "get_messages") {
      sendMessagesToClient(socket);
    } else if (parsedMessage.type === "ready") {
      let conversationsToCreate = [];
      let conversations = clients.get(socket)?.conversations;
      for (let i = 0; i < createdConversations.length; i++) {
        if (createdConversations[i].includes(userId)) {
          let found = false;

          for (let element of clients.get(socket)?.conversations) {
            if (arraysAreEqual(element.users, createdConversations[i])) {
              found = true;
              break;
            }
          }

          if (!found) {
            conversations.push({ users: createdConversations[i] });
          }
        }
      }

      console.log(conversations);

      socket.send(
        JSON.stringify({
          type: "connection",
          status: {
            code: "success",
            message: "Connection established",
          },
          data: {
            userId: userId,
            authToken: authToken,
            conversations: clients.get(socket)?.conversations
          }
        })
      );
    } else if (parsedMessage.type === "message") {
      // console.log(payload)
      if (payload.recipientIds.length < 1) {
        payload.recipientIds[0] = "global-chat";
      }
      allMessages.push(payload);

      for (let client of wss.clients) {
        if (client != socket && payload.recipientIds.includes(clients.get(client)?.userId)) {
          let conversation = clients.get(client)?.conversations;
          let found = false;
          for (let i = 0; i < conversation.length; i++) {
            if (arraysAreEqual(conversation[i].users, payload.recipientIds)) {
              found = true;
              break;
            }
          }

          createdConversations.push(payload.recipientIds);

          if (found === false) {
            conversation.push({ users: payload.recipientIds });

            client.send(
              JSON.stringify({
                type: "create_conversation",
                status: {
                  code: "success",
                  message: "Conversation created",
                },
                data: {
                  // name: name,
                  filteredUsers: payload.recipientIds
                }
              })
            );
          }
          // console.log(`CONVO (${clients.get(client)?.userId})`, conversation);
          // console.log(`CONVO EXISTS`, conversation.indexOf(payload.recipientIds));
          // console.log(`CONVO NUMBER`, conversation[conversation.indexOf(payload.recipientIds.sort)])
          // for (let element of conversation)
        }
      }

      const key = getConversationKey(payload.recipientIds);

      if (!messagesByConversations[key]) messagesByConversations[key] = [];
      messagesByConversations[key].push(payload);

      // console.log(messagesByConversations);

      payload.recipientIds

      sendMessagesToClients();
    } else if (parsedMessage.type === "create_conversation") {
      const users = payload.users.filter(user => userIdsList.includes(user));
      // for (let i = 0; i < userIdsList.length; i++) {
      //   if (userIdsList.includes(users[i])) {
      //     users.push(users[i]);
      //   }
      // }

      const conversations = clients.get(socket)?.conversations;
      let discrepancies = 0;
      for (let i = 0; i < users.length; i++) {
        let found = false;
        for (let j = 0; j < conversations.length; j++) {
          if (conversations[j].users.includes(users[i])) {
            found = true;
            break;
          }
        }

        if (!found) discrepancies++;
      };
      // console.log(conversations);
      // console.log(discrepancies);

      if (discrepancies == 0) {
        socket.send(
          JSON.stringify({
            type: "create_conversation",
            status: {
              code: "failure",
              message: "Conversation already exists",
            },
          })
        );

        return;
      };

      conversations.push({ users: users });

      console.dir(clients.get(socket), { depth: null });

      socket.send(
        JSON.stringify({
          type: "create_conversation",
          status: {
            code: "success",
            message: "Conversation created",
          },
          data: {
            // name: name,
            filteredUsers: users
          }
        })
      );

    };
  });

  socket.on("close", () => {
    clients.delete(socket);

    const index = userIdsList.indexOf(userId);
    if (index !== -1) {
      userIdsList.splice(index, 1);
    }

    clearInterval(pingInterval);
    console.log(`${userId} disconnected`);
  });

});

const sendMessagesToClients = () => {
  console.log("sending messages to clients");
  for (let client of wss.clients) {
    sendMessagesToClient(client);
  }
}

function sendMessagesToClient(client) {
  let messagesToSend = [];
  for (let i = 0; i < allMessages.length; i++) {
    // console.log(messages[i].recipientIds.includes(clients.get(client)?.userId));
    if (allMessages[i].recipientIds.includes(clients.get(client)?.userId) ||
      allMessages[i].recipientIds.length < 1 ||
      allMessages[i].recipientIds[0] === "global-chat") {
      for (let client of wss.clients) {
        if (allMessages[i].senderId === clients.get(client)?.userId) {
          allMessages[i].profileColour = clients.get(client)?.profileColour;
        }
      }

      messagesToSend.push(allMessages[i]);
    }
  }

  client.send(
    JSON.stringify({
      type: "messages",
      data: {
        messages: messagesToSend
      }
    })
  );
}

server.listen(port, () => {
  console.log(`Server running at https://localhost:${port}`);
});
