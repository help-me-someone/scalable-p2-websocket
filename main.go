package main

import (
	"fmt"
	"log"

	"github.com/ambelovsky/gosf"
)

func echo(client *gosf.Client, request *gosf.Request) *gosf.Message {
	fmt.Println(request.Message.Text)
	return gosf.NewSuccessMessage(request.Message.Text)
}

func init() {
	gosf.OnConnect(func(client *gosf.Client, request *gosf.Request) {
		log.Println("Client connected.")
	})
	gosf.Listen("echo", echo)
}

func main() {
	port := 5001
	fmt.Printf("Starting websocket server on port %d\n", port)
	gosf.Startup(map[string]interface{}{
		"port":       port,
		"enableCORS": "*",
	})
}
