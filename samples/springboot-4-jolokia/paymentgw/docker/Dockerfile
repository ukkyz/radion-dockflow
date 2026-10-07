# Use a lightweight runtime image
FROM eclipse-temurin:21-jre-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy the compiled JAR file into the container
# Note: Adjust the source path if you are using Gradle (build/libs/*.jar)
COPY target/*.jar app.jar

# Expose the default Spring Boot port
EXPOSE 8080

# Execute the application
ENTRYPOINT ["java", "-jar", "app.jar"]