var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');
var WebSocketServer = require('ws').Server;

/* Get target file */
var file = process.argv.length > 2 ? process.argv[2] : null;
if (!file) {
    console.error('No file specified!');
    return;
}

/* Client notification logic */
var watchActive = null;
var clients = [];
var notifyClients = function (packet) {
    clients.forEach(client => client.send(JSON.stringify(packet)));
};
var disconnectClient = function (socket) {
    clients.splice(clients.indexOf(socket), 1);
    /* Do not monitor files, if no one is listening */
    if (clients.length == 0) {
        watchActive.close();
        watchActive = null;
    }
};

/* Watch & Parse file */
var parsedData = null;
var lastData = "";
var last = null;
var reloadFile = function() 
{
    var id = 0;
    var output = [];
    var data = fs.readFileSync(file, {encoding: 'UTF-8'});

    /* If we already parsed content, skip it and only append */
    if (lastData && data.substr(0, lastData.length) == lastData) {
        output = parsedData;
        data = data.substr(lastData.length);
    } else {
        last = null;
        lastData = "";
    }
    if (!data && !lastData) return;
    
    var lines = data.split("\n");
    
    /* Append left data from previous read */
    if (lastData && lines.length) {
        var appendContent = lines.shift();
        var targetObj;
        
        if (last) {
            targetObj = last.childs[last.childs.length - 1];
        } else {
            targetObj = output[output.length - 1];
        }
        targetObj.text += appendContent;
        notifyClients({"type": "appendlog", lastId: last ? last.id : null, data: appendContent});
    }
    lines.forEach(function (value) {
        /* Find commands */
        for (var c = 0; c < value.length; ++c) {
            if (value[c] != "+") {
                if (c > 0) {
                    var obj = {id: ++id, text: value.substr(c), childs: []};
                    output.push(obj);
                    last = obj;
                    if (lastData) notifyClients({type: "newcmd", data: obj});
                    return;
                } 
                break;
            }
        }
        
        /* Add output */
        var newObj = {text: value};
        
        if (!last) {
            output.push(newObj);
            if (lastData) notifyClients({type: "newlog", lastId: null, data: newObj});
        }
        else {
            last.childs.push(newObj);
            if (lastData) notifyClients({type: "newlog", lastId: last.id, data: newObj});
        }
    });
    if (!lastData) notifyClients({type: "fulllog", data: parsedData});
    parsedData = output;
    lastData += data;
};

/* Load initial data and make sure to be notified of changes */
var ensureWatching = function() {
    if (watchActive) return;
    watchActive = fs.watch(file, reloadFile);
    reloadFile();
};

/* Initialize websocket server */
var fileStaticPath = path.join(__dirname, 'static');
var serverError = function (res, errorCode, message) {
    res.writeHead(403, {"Content-Type": "text/plain"});
    res.write(message);
    res.end();
};

/* Serve static files */
var httpServer = http.createServer(function (req, res) {
    var requestedPath = url.parse(req.url).pathname;
    if (requestedPath == '/') requestedPath = 'index.html';
    
    var filePath = path.join(fileStaticPath, requestedPath);
    if (filePath.indexOf(fileStaticPath) !== 0) {
        return serverError(res, 403, 'Invalid directory traversal');
    }
    if (!fs.existsSync(filePath)) return serverError(res, 404, 'File does not exist');
    var stat = fs.statSync(filePath);
    if (stat.isDirectory()) return serverError(res, 403, 'Directory listing denied');
    
    var contentType = filePath.substr(-4) == ".css" ? 'text/css' : 'text/html';
    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size
    });

    var readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
});

var server = new WebSocketServer({server: httpServer});
server.on('connection', function (ws) {
    ensureWatching();

    /* track client and send current state */
    clients.push(ws);
    ws.send(JSON.stringify({type: "fulllog", data: parsedData}));

    /* remove from tracking */
    ws.on('close', () => disconnectClient(ws));
});
httpServer.listen(8066);
