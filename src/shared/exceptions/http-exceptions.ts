export class HttpException extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = this.constructor.name;
  }
}
export class BadRequestException extends HttpException {
  constructor(message = "Bad Request") { super(400, message); }
}
export class NotFoundException extends HttpException {
  constructor(message = "Not Found") { super(404, message); }
}
